/**
 * CodexTmuxBridge — state-aware event injection into Codex CLI.
 *
 * Reads the Codex TUI screen via `tmux capture-pane`, detects the
 * current UI state, and applies the right injection strategy:
 *
 *   idle       → bracketed paste + Enter
 *   typing     → Ctrl+U (cut), bracketed paste + Enter, Ctrl+Y (restore)
 *   approval   → queue and poll
 *   streaming  → queue and poll
 *   blocked    → queue and poll (sign-in / onboarding — no composer exists yet)
 *   unknown    → queue and poll (safe default)
 *
 * Uses bracketed paste escape sequences to bypass Codex's timing-based
 * paste-burst detector (120ms Enter suppression window). Text wrapped
 * in ESC[200~...ESC[201~ is delivered as a Paste event, not individual
 * keystrokes, so the burst detector never fires.
 */

import {
  tmuxPaneIsShell,
  tmuxCapturePane,
  tmuxInjectPaste,
  tmuxSendEnter,
  tmuxSendKey,
} from "../tmux.js";
import { queueCodexMessage } from "./queue.js";
import { composerStillHolds } from "../composer.js";
import { contentPartsToString } from "../../agent/prompts.js";
import type { ContentPart } from "../../agent/types.js";

export type CodexTuiState =
  /**
   * The CLI is not running — the pane has fallen back to a shell. Injecting
   * here types a room message at the user's shell prompt, which is how
   * "zsh: command not found: Please" happened.
   */
  | "absent"
  | "idle"
  | "typing"
  | "approval"
  | "streaming"
  | "blocked"
  | "unknown";

// Braille spinner characters used by Codex during streaming
const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// Patterns that indicate an approval overlay.
// Codex has shipped several approval UIs; match all of them, since injecting
// into an approval menu answers a question the agent never saw.
const APPROVAL_PATTERNS: Array<string | RegExp> = [
  "Would you like to",
  "needs your approval",
  "Press Enter to confirm or Esc to cancel",
  "Do you want to approve",
  // v0.15x MCP tool approval: "Allow the apiary MCP server to run tool "x"?"
  /Allow the .+ MCP server to run tool/,
  "Allow for this session",
  // Strings taken from the Codex binary itself rather than guessed.
  "Allow Codex to run",
  "Allow Codex to apply proposed code changes?",
  "enter to submit | esc to cancel",
];

// Patterns that indicate Codex has not reached a composer at all — the
// sign-in flow, the onboarding wizard, or a directory-trust prompt. There is
// no prompt to paste into, so anything injected here is typed into a menu and
// lost. Queue instead, and the text lands once the human clears the screen.
const BLOCKED_PATTERNS: Array<string | RegExp> = [
  // Not a bare "Welcome to Codex" — the ordinary ready banner opens
  // "Welcome to Codex! Type a message to get started."
  /Welcome to Codex, /,
  "Finish signing in via your browser",
  "Sign in with ChatGPT",
  "Sign in with Device Code",
  "Provide your own API key",
  "Sign in to continue",
  // `[\s\S]` not `.`: the screen renders these on separate lines, and `.`
  // does not cross a newline, so the original pattern never matched.
  /You are running Codex in [\s\S]+Do you want to allow/,
  "Do you trust the files in this folder",
];

// Patterns that indicate the agent is actively working
const STREAMING_PATTERNS = [
  /Working\s*\(\d+[smh]/,       // "Working (12s" or "Working (1m 30s"
  /Working\s*$/,                  // "Working" at end of line (just started)
  /esc to interrupt/,             // hint text during streaming
];

// The footer of Codex's @-mention popup. Codex opens this when it reads a
// `@` as a typed character, and while it is open Enter means "insert the
// highlighted completion", not "submit" — see dismissMentionPopup.
const MENTION_POPUP_PATTERNS: RegExp[] = [
  /enter\s+insert\b[\s\S]{0,40}?esc\s+close/i,
];

/**
 * Is Codex's @-mention popup on screen?
 *
 * Exported for tests, and matched only against the bottom of the screen: the
 * popup is anchored above the composer, whereas an agent quoting the same
 * words in its transcript must not count.
 */
export function codexMentionPopupIsOpen(lines: string[]): boolean {
  const tail = lines.slice(-20).join("\n");
  return MENTION_POPUP_PATTERNS.some((p) => p.test(tail));
}

export interface DeliverOptions {
  /**
   * Drop this text if an identical copy is already queued. For callers that
   * retry a delivery they cannot observe landing (the room invite loop).
   */
  dedupe?: boolean;
}

export interface CodexTmuxBridgeOptions {
  /**
   * Resolve the Codex session id for this agent, if it can be known.
   *
   * When it returns an id, messages go through `codex queue` instead of the
   * composer — see queue.ts. Called lazily and memoised, because the session
   * does not exist until Codex has finished starting.
   */
  resolveThreadId?: () => string | null;
  /** How often to poll when events are queued (ms). Default: 200 */
  pollIntervalMs?: number;
  /** Delay after bracketed paste before sending Enter (ms). Default: 150 */
  pasteDelayMs?: number;
  /** Delay between Ctrl+U/inject/Ctrl+Y steps (ms). Default: 50 */
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

export class CodexTmuxBridge {
  private session: string;
  private queue: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private pasteDelayMs: number;
  private keystrokeDelayMs: number;
  private stopped = false;
  private resolveThreadId?: () => string | null;
  private threadId: string | null = null;
  private onUndelivered: (text: string) => void;

  constructor(session: string, opts?: CodexTmuxBridgeOptions) {
    this.session = session;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 200;
    this.pasteDelayMs = opts?.pasteDelayMs ?? 150;
    this.keystrokeDelayMs = opts?.keystrokeDelayMs ?? 50;
    this.resolveThreadId = opts?.resolveThreadId;
    this.onUndelivered = opts?.onUndelivered ?? defaultUndeliveredWarning;
  }

  /**
   * The Codex session id, resolved once and remembered.
   *
   * Resolution is deferred because the session does not exist at construction
   * time — Codex is still starting — and it is retried on later deliveries
   * until it succeeds.
   */
  private thread(): string | null {
    if (this.threadId) return this.threadId;
    if (!this.resolveThreadId) return null;
    try {
      this.threadId = this.resolveThreadId();
    } catch {
      this.threadId = null;
    }
    return this.threadId;
  }

  /**
   * Delivery callback — drop-in replacement for EventProcessor's deliver.
   * Pass `bridge.deliver.bind(bridge)` to EventProcessor.run().
   */
  async deliver(parts: ContentPart[], opts?: DeliverOptions): Promise<void> {
    const text = contentPartsToString(parts);
    if (!text.trim()) return;

    this.inject(text, opts?.dedupe === true);
  }

  /**
   * Detect the current TUI state by reading the screen.
   */
  detectState(): CodexTuiState {
    // Checked before any screen parsing: if the CLI has exited there is
    // nothing on screen worth interpreting, and a shell prompt looks
    // indistinguishable from an idle composer to a pattern matcher.
    if (tmuxPaneIsShell(this.session)) return "absent";
    const lines = this.captureScreen();
    return detectCodexStateFromLines(lines);
  }

  /**
   * Codex's live status text ("Working (12s • esc to interrupt)") for the room
   * strip, or null when idle. Mirrors the Claude bridge's getActivityLabel so
   * both runtimes can report the same shape.
   */
  getActivityLabel(): string | null {
    return extractCodexActivityLabel(this.captureScreen());
  }

  /**
   * Try to inject text, choosing strategy based on TUI state.
   * Text is flattened to a single line to avoid multi-line paste issues.
   */
  private inject(text: string, dedupe: boolean): void {
    const flat = text.replace(/\n/g, " ");
    const state = this.detectState();

    // Prefer handing the message to Codex itself. Nothing is typed, so the
    // composer's paste-vs-typing timing and its @-mention popup cannot apply,
    // and Codex holds the message for a busy agent rather than us polling for
    // an injectable moment. Skipped when the CLI is gone: queueing into a
    // session nothing is reading would silently swallow the message.
    if (state !== "absent") {
      const threadId = this.thread();
      if (threadId && queueCodexMessage(threadId, flat)) return;
    }

    switch (state) {
      case "idle":
        this.injectIdle(flat);
        break;
      case "typing":
        this.injectWhileTyping(flat);
        break;
      default:
        // approval, streaming, blocked, absent, unknown — queue it
        this.enqueue(flat, dedupe);
        break;
    }
  }

  /** Capture the screen via tmux capture-pane. */
  private captureScreen(): string[] {
    return tmuxCapturePane(this.session);
  }

  /**
   * Inject into an idle prompt using bracketed paste.
   *
   * Bracketed paste wraps text in ESC[200~...ESC[201~ so crossterm
   * delivers it as a single Paste event, bypassing the burst detector.
   * The wrapping happens in one write — see tmuxInjectPaste for why that
   * matters. After the paste, we wait for the Enter suppression window
   * (120ms) to expire, then send Enter to submit.
   */
  private injectIdle(text: string): void {
    tmuxInjectPaste(this.session, text);
    this.sleep(this.pasteDelayMs);
    this.dismissMentionPopup();
    tmuxSendEnter(this.session);
    this.confirmSubmitted(text);
  }

  /**
   * Check the message left the composer, and try once more if it did not.
   *
   * A submitted message moves into the transcript; one that is still in the
   * composer was not sent. The retry re-runs the popup guard first, because the
   * popup is what eats an Enter — and if the text is still there after that,
   * nothing this bridge can do will send it, so it says so rather than leaving
   * the room to infer silence.
   */
  private confirmSubmitted(text: string): void {
    this.sleep(this.pasteDelayMs);
    if (!composerStillHolds(this.captureScreen(), text)) return;

    this.dismissMentionPopup();
    tmuxSendEnter(this.session);
    this.sleep(this.pasteDelayMs);
    if (!composerStillHolds(this.captureScreen(), text)) return;

    this.onUndelivered(text);
  }

  /**
   * Close the @-mention popup before submitting, if the injection opened it.
   *
   * Codex classifies incoming bytes as a paste or as typing partly on timing,
   * so a payload we sent as a bracketed paste can still be read as typing on a
   * loaded machine. When that happens a `@` opens the mention popup, and Enter
   * there *inserts the highlighted completion* instead of submitting. On
   * 2026-09-10 that turned a room message reading "sooo @all" into
   * "sooo @Openai-Templates" — the top hit was an installed Codex plugin — and
   * left it unsent in the composer, so the next message appended to the same
   * stuck line and the agent looked like it was ignoring the operator.
   *
   * Escape closes the popup and leaves the composed text untouched, so the
   * Enter that follows submits what we actually injected.
   *
   * Only ever sent when the popup is on screen: Escape is also Codex's
   * interrupt, so an unconditional one would cancel a turn in progress.
   */
  private dismissMentionPopup(): void {
    if (!codexMentionPopupIsOpen(this.captureScreen())) return;
    tmuxSendKey(this.session, "Escape");
    this.sleep(this.keystrokeDelayMs);
  }

  /**
   * Inject while the user is typing:
   * 1. Ctrl+U — cut to beginning of line (into kill buffer)
   * 2. Bracketed paste our text + Enter
   * 3. Ctrl+Y — yank user's text back from kill buffer
   */
  private injectWhileTyping(text: string): void {
    // Cut user's current input
    tmuxSendKey(this.session, "C-u");
    this.sleep(this.keystrokeDelayMs);

    // Inject our event via bracketed paste
    tmuxInjectPaste(this.session, text);
    this.sleep(this.pasteDelayMs);
    this.dismissMentionPopup();
    tmuxSendEnter(this.session);
    this.confirmSubmitted(text);
    this.sleep(this.keystrokeDelayMs);

    // Restore user's text
    tmuxSendKey(this.session, "C-y");
  }

  /**
   * Add to queue and start polling if not already.
   *
   * With `dedupe`, identical pending text is dropped: a caller that retries a
   * delivery it never saw land (the invite loop) would otherwise stack up N
   * copies of the same prompt, all flushing at once when the TUI frees up.
   *
   * Off by default, and deliberately so — room events must never be collapsed.
   * Two formatted events carry distinct `#ref`s so they should differ anyway,
   * but "should" is not a guarantee worth silently dropping a message on.
   */
  private enqueue(text: string, dedupe: boolean): void {
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
   * Drains one at a time — each injection may trigger streaming,
   * so the next poll re-checks state before injecting more.
   */
  private drainQueue(): void {
    if (this.queue.length === 0) {
      this.stopPolling();
      return;
    }

    const state = this.detectState();
    if (state === "idle" || state === "typing") {
      const text = this.queue.shift()!;

      if (state === "idle") {
        this.injectIdle(text);
      } else {
        this.injectWhileTyping(text);
      }

      if (this.queue.length === 0) {
        this.stopPolling();
      }
    }
    // else: still blocked, keep polling
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

// ── State detection heuristics ──────────────────────────────────────────────

/**
 * Detect Codex TUI state from capture-pane output lines.
 * Exported separately so it can be unit-tested without tmux.
 *
 * Codex's TUI (Ratatui-based) uses an inline viewport. The screen shows:
 *   - Conversation history in the top area
 *   - Status indicator ("Working (12s * esc to interrupt)") when streaming
 *   - Approval overlay when tool/patch approval needed
 *   - Composer input area at the bottom
 *
 * Detection priority: approval > streaming > idle/typing > unknown
 */
/**
 * Case-INSENSITIVE match against the UI-chrome patterns.
 *
 * Codex has changed the casing of its own hint text between releases: the
 * dialog reads "Press enter to confirm or esc to cancel" in v0.153.4 where an
 * earlier build capitalised Enter and Esc. A case-sensitive miss here is the
 * dangerous direction — the screen falls through to "idle" and the bridge
 * bracket-pastes a room event plus Enter into a live approval dialog, choosing
 * an answer for a question the agent never saw. A false positive only queues
 * the event for the drain loop to retry, so lean toward matching.
 */
function matchesAny(text: string, patterns: Array<string | RegExp>): boolean {
  const haystack = text.toLowerCase();
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (haystack.includes(pattern.toLowerCase())) return true;
    } else if (pattern.test(text) || new RegExp(pattern.source, pattern.flags.includes("i") ? pattern.flags : pattern.flags + "i").test(text)) {
      return true;
    }
  }
  return false;
}

export function detectCodexStateFromLines(lines: string[]): CodexTuiState {
  if (lines.length === 0) return "unknown";

  // Work with the last ~20 lines (visible bottom of screen)
  const tail = lines.slice(-20);
  const tailText = tail.join("\n");

  // 1. Not-yet-usable screens — highest priority. A login or onboarding
  //    screen has no composer, so "no approval, no spinner ⇒ idle" would
  //    otherwise paste straight into a menu.
  if (matchesAny(tailText, BLOCKED_PATTERNS)) return "blocked";

  // 2. Approval overlay
  if (matchesAny(tailText, APPROVAL_PATTERNS)) return "approval";

  // 3. Streaming — agent is working
  for (const pattern of STREAMING_PATTERNS) {
    if (pattern.test(tailText)) return "streaming";
  }

  // Check for spinner characters in the last few lines
  const lastFew = tail.slice(-5).join("");
  for (const ch of SPINNER_CHARS) {
    if (lastFew.includes(ch)) return "streaming";
  }

  // 4. Idle/Typing — look for the composer input area at the bottom.
  //    Codex renders the composer as the last interactive element.
  //    When idle, the bottom lines contain just the placeholder or empty input.
  //    When typing, the bottom lines contain user-entered text.
  //
  //    Heuristic: if none of the blocking states are detected (approval,
  //    streaming), and the screen has content, assume the composer is
  //    available. Check the last non-empty line for signs of user input.
  //
  //    This is intentionally permissive — the worst case for a false
  //    "idle" is that the injected text arrives during an unexpected
  //    state and queues up in the input buffer harmlessly.
  const nonEmpty = tail.filter((l) => l.trim().length > 0);
  if (nonEmpty.length > 0) {
    // Look for signs that the screen is showing normal conversation + composer.
    // If we didn't match approval or streaming above, the composer is likely visible.
    // We need to distinguish idle (empty composer) from typing (text in composer).
    //
    // Codex shows a cursor line at the very bottom. Without empirical data on
    // exact patterns, we check if the last non-empty line looks like user input
    // (not part of conversation output which typically has structure like timestamps,
    // tool names, or markdown formatting).
    //
    // For now: if no blocking state is detected, return "idle" as the safe
    // injectable state. The bracketed paste approach is resilient enough that
    // injecting into a "typing" state via the idle path still works (text gets
    // appended to whatever the user was typing, and Enter submits all of it).
    return "idle";
  }

  return "unknown";
}

/**
 * Pull Codex's status line out of a screen capture.
 *
 * Exported separately so it can be tested without tmux. Returns null when
 * nothing is running — the room shows the state glyph alone in that case.
 */
export function extractCodexActivityLabel(lines: string[]): string | null {
  // Scan bottom-up: the status line lives just under the transcript, and
  // earlier conversation text can quote the same words.
  for (const line of lines.slice(-12).reverse()) {
    const m = /(Working|Thinking|Compacting|Reviewing)\b[^)\n]*/.exec(line);
    if (!m) continue;
    // Trim Codex's interrupt hint — it is UI chrome, not progress.
    const label = m[0].replace(/\s*[•·]?\s*esc to interrupt.*$/i, "").trim();
    if (label) return label.slice(0, 120);
  }
  return null;
}
