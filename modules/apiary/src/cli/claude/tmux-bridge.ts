/**
 * TmuxBridge — state-aware event injection into Claude Code.
 *
 * Reads the Claude Code TUI screen via `tmux capture-pane`, detects the
 * current UI state, and applies the right injection strategy:
 *
 *   idle       → inject directly
 *   typing     → Ctrl+U (cut), inject, Ctrl+Y (restore)
 *   dialog     → queue and poll
 *   permission → queue and poll
 *   streaming  → queue and poll
 *   unknown    → queue and poll (safe default)
 *
 * Events that can't be injected immediately are queued and drained
 * when the state becomes safe.
 */

import {
  tmuxPaneIsShell,
  tmuxCapturePane,
  tmuxInjectText,
  tmuxSendEnter,
  tmuxSendKey,
} from "../tmux.js";
import { composerStillHolds } from "../composer.js";
import { contentPartsToString } from "../../agent/prompts.js";
import type { ContentPart } from "../../agent/types.js";

export type TuiState =
  /** The CLI is not running — the pane has fallen back to a shell. */
  | "absent"
  | "idle"
  | "typing"
  | "dialog"
  | "permission"
  | "streaming"
  | "unknown";

// Spinner characters used by Claude Code during streaming
const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * Claude Code is busy in a way that shows NO spinner.
 *
 * While a subagent runs, the main area is quiet and the only sign is the
 * footer: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent".
 * Spinner-only detection therefore read the pane as idle, so apiary pasted
 * into a composer that will not submit — verified against a live agent, where
 * even a manual Enter did nothing — and the message sat there as a draft until
 * the subagent finished. The room showed the agent as idle throughout.
 */
const BUSY_PATTERNS: RegExp[] = [
  // "← 1 agent" / "← 3 agents"
  /←\s*\d+\s+agents?\b/,
];

// Patterns that indicate a selection/question dialog
const DIALOG_PATTERNS = [
  "Enter to select",
  "to navigate",
  "Esc to cancel",
  "Ready to code?",
  "Review your answers",
  "ctrl+g to edit in",
];

// Patterns that indicate a permission/confirmation prompt
const PERMISSION_PATTERNS = [
  "(Y)",
  "Allow ",
  "Deny ",
  "approve",
  "Yes / No",
  // Current Claude Code wording, captured from a live prompt. Without these a
  // permission dialog reads as idle and the bridge pastes a room event into
  // it, answering on the agent's behalf.
  "Do you want to proceed?",
  "don't ask again",
  // The folder-trust modal, which no flag skips.
  "Yes, I trust this folder",
];

/**
 * Patterns specific enough to put "⏸ needs you" in front of a human.
 *
 * DIALOG_PATTERNS and PERMISSION_PATTERNS above deliberately over-match, and
 * for their original consumer that is correct: they gate DELIVERY, where a
 * false positive only queues a room event for the drain loop to retry. Cheap.
 *
 * That reasoning was then reused for a second consumer with the opposite cost
 * — the agent state reported to the room — where a false positive stops the
 * operator and makes them wait on an agent that needs nothing. Observed: the
 * bare substring `"approve"` matched an agent's own tool output, "hard cap, set
 * by the approved top", and the room strip read "⏸ needs you" at an agent 23
 * minutes into a harness run. `"to navigate"` is the same trap and worse — it
 * matches any sentence about navigating, in a project whose entire subject is
 * navigating by bearings.
 *
 * So: two lists. Over-match to protect the agent, under-match before
 * interrupting the human. These are UI chrome a prompt actually renders —
 * wordings and shapes, not vocabulary that can occur in prose.
 */
const BLOCKING_PATTERNS: Array<string | RegExp> = [
  "Do you want to proceed?",
  "don't ask again",
  "Yes, I trust this folder",
  "Ready to code?",
  "Enter to select",
  /❯\s*1\.\s*Yes/,
  /\(y\s*\/\s*n\)/i,
  // The arrow glyphs claude renders beside it. Bare "to navigate" is prose.
  /[↑↓⬆⬇]\s*(?:[↑↓⬆⬇]\s*)?to navigate/,
];

/** Match a mixed string/RegExp pattern list, case-insensitively for strings. */
function matchesAny(text: string, patterns: Array<string | RegExp>): boolean {
  const haystack = text.toLowerCase();
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (haystack.includes(pattern.toLowerCase())) return true;
    } else if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

export interface DeliverOptions {
  /**
   * Drop this text if an identical copy is already queued. For callers that
   * retry a delivery they cannot observe landing (the room invite loop).
   */
  dedupe?: boolean;
}

export interface TmuxBridgeOptions {
  /** How often to poll when events are queued (ms). Default: 200 */
  pollIntervalMs?: number;
  /** How long to wait between Ctrl+U/inject/Ctrl+Y steps (ms). Default: 50 */
  keystrokeDelayMs?: number;
  /**
   * Called when a message could not be got into the agent, after the retry.
   *
   * Delivery used to be assumed: apiary typed, reported success and moved on,
   * so a swallowed submit looked exactly like an agent choosing not to answer.
   * This is the hook that makes the difference visible to someone.
   */
  onUndelivered?: (text: string) => void;
}

/**
 * Last resort when no one has wired a handler: say it on stderr, which lands in
 * the launcher pane. Better than nothing, and a great deal better than success.
 */
function defaultUndeliveredWarning(text: string): void {
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  process.stderr.write(`apiary: message NOT delivered to the agent — still in its composer: ${preview}\n`);
}

export class TmuxBridge {
  private session: string;
  private queue: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private keystrokeDelayMs: number;
  private onUndelivered: (text: string) => void;
  private stopped = false;
  private blockedCount = 0;
  private static readonly BLOCKED_THRESHOLD = 150; // ~30s at 200ms poll — force inject if stuck

  constructor(session: string, opts?: TmuxBridgeOptions) {
    this.session = session;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 200;
    this.keystrokeDelayMs = opts?.keystrokeDelayMs ?? 50;
    this.onUndelivered = opts?.onUndelivered ?? defaultUndeliveredWarning;
  }

  /**
   * Delivery callback — drop-in replacement for the raw tmuxDeliver lambda.
   * Pass `bridge.deliver.bind(bridge)` to EventProcessor.run().
   */
  async deliver(parts: ContentPart[], opts?: DeliverOptions): Promise<void> {
    const text = contentPartsToString(parts);
    if (!text.trim()) return;

    this.inject(text, opts?.dedupe === true);
  }

  /**
   * Detect the current TUI state by reading the screen.
   * Exported for testing — the heuristic logic is in detectStateFromLines().
   */
  detectState(): TuiState {
    // See the Codex bridge: a shell prompt is indistinguishable from an idle
    // composer once you are only looking at rendered text.
    if (tmuxPaneIsShell(this.session)) return "absent";
    const lines = this.captureScreen();
    return detectStateFromLines(lines);
  }

  /**
   * State to REPORT to the room, as opposed to the state used to decide
   * whether it is safe to type. Same screen, stricter about claiming a human
   * is needed — see detectReportedStateFromLines.
   */
  detectReportedState(): TuiState {
    if (tmuxPaneIsShell(this.session)) return "absent";
    return detectReportedStateFromLines(this.captureScreen());
  }

  /**
   * Extract claude's live status label from the pane (the "Sautéed for 12s",
   * "Compacting conversation… 23%" lines under the prompt). Returns null when
   * the agent is idle / no status visible.
   *
   * The room TUI calls this through the agent runtime's poll loop to surface
   * "is the agent actually working or stuck?" without making the user attach
   * to each tmux pane.
   */
  getActivityLabel(): string | null {
    return extractActivityLabel(this.captureScreen());
  }

  /**
   * Try to inject text, choosing strategy based on TUI state.
   * If the state is unsafe, queues the text and starts polling.
   *
   * Text is flattened to a single line before injection to avoid triggering
   * Claude Code's paste detection. When multi-line text arrives via
   * `send-keys -l`, Claude Code detects it as a paste and collapses it into
   * "[Pasted text #1 +N lines]" which may not reliably submit with Enter.
   */
  private inject(text: string, dedupe: boolean): void {
    const flat = text.replace(/\n/g, " ");
    const state = this.detectState();

    switch (state) {
      case "idle":
        this.injectIdle(flat);
        break;
      case "typing":
        this.injectWhileTyping(flat);
        break;
      default:
        // dialog, permission, streaming, unknown — queue it
        this.enqueue(flat, dedupe);
        break;
    }
  }

  /** Capture the screen via tmux capture-pane. */
  private captureScreen(): string[] {
    return tmuxCapturePane(this.session);
  }

  /**
   * Inject into an idle prompt: type text + Enter, then check it went.
   *
   * This used to fire a second Enter unconditionally as a "safety net" against
   * Claude Code's paste detection swallowing the first. That is a guess in both
   * directions: it cannot tell whether the first Enter worked, and it cannot
   * tell whether the second one did either. Reading the composer back answers
   * the question instead, and only sends the second Enter when it is needed.
   */
  private injectIdle(text: string): void {
    tmuxInjectText(this.session, text);
    tmuxSendEnter(this.session);
    this.confirmSubmitted(text);
  }

  /**
   * Check the message left the composer, and press Enter once more if it did not.
   *
   * A submitted message moves into the transcript; one still in the composer was
   * never sent. If it is still there after the retry, the room is told rather
   * than left to read the agent's silence as a choice.
   */
  private confirmSubmitted(text: string): void {
    this.sleep(80);
    if (!composerStillHolds(this.captureScreen(), text)) return;

    tmuxSendEnter(this.session);
    this.sleep(120);
    if (!composerStillHolds(this.captureScreen(), text)) return;

    this.onUndelivered(text);
  }

  /**
   * Inject while the user is typing:
   * 1. Ctrl+U — cut line to kill ring
   * 2. Inject our text + Enter
   * 3. Ctrl+Y — paste the user's text back
   */
  private injectWhileTyping(text: string): void {
    // Cut user's current input
    tmuxSendKey(this.session, "C-u");
    this.sleep(this.keystrokeDelayMs);

    // Inject our event, then confirm rather than hope
    tmuxInjectText(this.session, text);
    tmuxSendEnter(this.session);
    this.confirmSubmitted(text);
    this.sleep(this.keystrokeDelayMs);

    // Restore user's text
    tmuxSendKey(this.session, "C-y");
  }

  /** Add to queue and start polling if not already. */
  private enqueue(text: string, dedupe: boolean): void {
    // Off by default — room events must never be collapsed. Only callers that
    // retry a delivery they cannot observe landing (the invite loop) opt in.
    if (dedupe && this.queue.includes(text)) return;
    this.queue.push(text);
    this.startPolling();
  }

  /** Start the polling timer to drain queued events. */
  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.pollTimer = setInterval(() => this.drainQueue(), this.pollIntervalMs);
  }

  /** Stop the polling timer. */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Try to drain one queued event if the state is safe.
   *
   * Drains one event at a time rather than batching all into one multi-line
   * string — multi-line text triggers Claude Code's paste detection which
   * collapses it into "[Pasted text #1 +N lines]".
   *
   * After injecting one event, the poll continues. The next cycle re-checks
   * state: if Claude is busy (streaming), remaining events wait. If idle,
   * the next event is injected. Events are already flattened in inject().
   */
  private drainQueue(): void {
    if (this.queue.length === 0) {
      this.stopPolling();
      this.blockedCount = 0;
      return;
    }

    const state = this.detectState();
    if (state === "idle" || state === "typing") {
      this.blockedCount = 0;
      const text = this.queue.shift()!;

      if (state === "idle") {
        this.injectIdle(text);
      } else {
        this.injectWhileTyping(text);
      }

      if (this.queue.length === 0) {
        this.stopPolling();
      }
      // else: keep polling to drain remaining events
    } else {
      // Any non-injectable state (streaming, dialog, permission, unknown)
      this.blockedCount++;
      if (this.blockedCount >= TmuxBridge.BLOCKED_THRESHOLD) {
        // Stuck too long — force inject to unblock
        this.blockedCount = 0;
        const text = this.queue.shift()!;
        this.injectIdle(text);
        if (this.queue.length === 0) this.stopPolling();
      }
    }
  }

  /** Cleanup. */
  stop(): void {
    this.stopped = true;
    this.stopPolling();
    this.queue.length = 0;
  }

  /** Synchronous sleep — only used for tiny keystroke delays. */
  private sleep(ms: number): void {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

// ── Activity label extraction ────────────────────────────────────────────────

/**
 * Pull claude's status string out of a captured pane.
 *
 * Claude's TUI shows these markers above the input prompt while it's working:
 *   ✻ Fluttering… (38s · ↓ 2.1k tokens)     <- the LIVE form, present throughout
 *   ✻ Sautéed for 12s                        <- the FINISHED form, a moment at the end
 *   ✻ Compacting conversation… 23%
 *   ✻ Thinking…
 *
 * Three patterns, tried narrowest-first so the broad one cannot swallow the
 * others:
 *   - PROG: a known long-op verb (Compacting/Thinking/Loading/Connecting)
 *     followed by an optional description and optional N%. Stops at the first
 *     `(` so it doesn't capture a trailing metadata blob.
 *   - COOK: cooking-verb + "for Ns", the form claude leaves behind once a turn
 *     ends. Matches unicode letters (Sautéed) via the Latin-1 supplement range.
 *   - LIVE: any word, an ellipsis, and a parenthesised progress group. Matched
 *     on SHAPE rather than vocabulary, because the verb is whimsical and
 *     rotates — Improvising, Fluttering, Reticulating, Cogitating. A word list
 *     goes stale the next time someone adds one, which is exactly how this
 *     broke: with only COOK and PROG, a *working* agent matched nothing and
 *     reported no label, so the room strip showed a bare glyph for as long as
 *     the work took. The one moment the operator most needs to know what is
 *     happening was the one moment it said nothing.
 *
 * LIVE deliberately keeps its parenthesised group — "(38s · ↓ 2.1k tokens)" is
 * the elapsed time and stream progress, which is what distinguishes "moving"
 * from "wedged". PROG still stops at `(` because its verbs carry their own
 * detail, and it is tried first so that stays true.
 *
 * Scan the last ~25 lines, return the newest match. Null when none → idle.
 */
const ACTIVITY_LIVE = /([A-Za-zÀ-ÿ]+…\s*\([^)\n]*\))/;
const ACTIVITY_COOK = /([A-Za-zÀ-ÿ]+ed\s+for\s+\d+s)/;
const ACTIVITY_PROG = /((?:Compacting|Thinking|Loading|Connecting)[^()]*?(?:\s+\d+%)?)(?=\s*[(\n]|\s*$)/;
export function extractActivityLabel(lines: string[]): string | null {
  if (lines.length === 0) return null;
  let best: string | null = null;
  for (const line of lines.slice(-25)) {
    // PROG first, then COOK, then LIVE. LIVE is the broadest — any word plus a
    // parenthesised group — so it must go last or it swallows lines the narrower
    // patterns own: "Compacting conversation… (2m 9s · ↑ 3.3k tokens)" is
    // reported as "Compacting conversation…" on purpose, and LIVE-first turned
    // that into "conversation… (2m 9s · ↑ 3.3k tokens)".
    const m = line.match(ACTIVITY_PROG) ?? line.match(ACTIVITY_COOK) ?? line.match(ACTIVITY_LIVE);
    if (m) best = m[1].trim();
  }
  return best;
}

// ── State detection heuristics ──────────────────────────────────────────────

/**
 * Detect TUI state from capture-pane output lines.
 * Exported separately so it can be unit-tested without tmux.
 *
 * Claude Code's TUI layout (v2.1+):
 *   ────────────────────────
 *   ❯ <user input here>
 *   ────────────────────────
 *   PR #2         /ide ...
 *
 * The ❯ prompt sits between separator lines (─). No ❯❯ footer in v2.1+.
 */
export function detectStateFromLines(
  lines: string[],
  opts?: { ignorePrompts?: boolean },
): TuiState {
  if (lines.length === 0) return "unknown";

  // Work with the last ~30 lines (the visible bottom of the screen)
  const tail = lines.slice(-30);
  const tailText = tail.join("\n");

  // `ignorePrompts` asks "what is this screen doing APART from any prompt?" —
  // used by detectReportedStateFromLines to answer the human's question once
  // the loose lists have been found to be matching prose rather than chrome.
  if (opts?.ignorePrompts !== true) {
    // 1. Dialog: selection/question/plan approval
    for (const pattern of DIALOG_PATTERNS) {
      if (tailText.includes(pattern)) return "dialog";
    }

    // 2. Permission prompt
    for (const pattern of PERMISSION_PATTERNS) {
      if (tailText.includes(pattern)) return "permission";
    }
  }

  // 3. Streaming: spinner characters in the last few lines
  const lastFew = tail.slice(-5).join("");
  for (const ch of SPINNER_CHARS) {
    if (lastFew.includes(ch)) return "streaming";
  }

  // 3b. Busy with no spinner — a subagent is running. Checked after the
  //     dialog and permission patterns on purpose: a prompt that needs a human
  //     outranks "also busy", because only one of those the user can clear.
  for (const pattern of BUSY_PATTERNS) {
    if (pattern.test(tailText)) return "streaming";
  }

  // 4. Look for the ❯/› prompt line near the bottom.
  //    Supports both old layout (❯❯ footer) and new layout (separator lines).
  const promptChar = /^[❯›](\s|$)/;
  const footerChar = /^[❯›]{2}\s/;
  const separatorLine = /^[─━─\-]{10,}/;

  // Strategy A: old layout — find ❯❯ footer then ❯ prompt above it
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trimStart();
    if (footerChar.test(line)) {
      // Found old-style footer, look for prompt above
      for (let j = i - 1; j >= 0; j--) {
        const above = tail[j].trimStart();
        if (promptChar.test(above)) {
          const content = above.replace(/^[❯›]\s*/, "").trim();
          return content.length === 0 ? "idle" : "typing";
        }
      }
      break;
    }
  }

  // Strategy B: new layout — find ❯ prompt between/near separator lines
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trimStart();
    if (promptChar.test(line)) {
      // Verify it's Claude's prompt by checking for separator line nearby
      const above = i > 0 ? tail[i - 1].trimStart() : "";
      const below = i < tail.length - 1 ? tail[i + 1].trimStart() : "";
      if (separatorLine.test(above) || separatorLine.test(below)) {
        const content = line.replace(/^[❯›]\s*/, "").trim();
        return content.length === 0 ? "idle" : "typing";
      }
    }
  }

  return "unknown";
}

/**
 * The same screen read, but tuned for a human rather than for the delivery
 * queue: only claim a prompt is waiting when one is actually on screen.
 *
 * `detectStateFromLines` leans toward "there is a prompt" because a false
 * positive there merely queues an event. This one leans the other way, because
 * its false positive is "⏸ needs you" in the operator's face at an agent that
 * needs nothing — which costs a person's attention, and teaches them to stop
 * trusting the strip. When the loose lists fire but no specific prompt wording
 * is present, the screen is re-read with the prompt scan disabled so the
 * spinner and composer get to answer instead.
 */
export function detectReportedStateFromLines(lines: string[]): TuiState {
  const loose = detectStateFromLines(lines);
  if (loose !== "dialog" && loose !== "permission") return loose;
  if (matchesAny(lines.slice(-30).join("\n"), BLOCKING_PATTERNS)) return loose;
  return detectStateFromLines(lines, { ignorePrompts: true });
}
