/**
 * apiary TUI — ink-based terminal UI for the room server.
 *
 * Uses ink's <Static> for events (rendered once, selectable terminal text)
 * and a dynamic footer for input + status. Same architecture as Claude Code.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { render, Box, Text, Static, useStdout, useInput } from "ink";

// ── Palette (from apiary-app) ─────────────────────────────────────────────────

const C = {
  cyan:      "#00d4ff",
  purple:    "#8b5cf6",
  orange:    "#ff8c42",
  pink:      "#f472b6",
  green:     "#34d399",
  yellow:    "#fbbf24",
  danger:    "#f87171",
  text:      "#eceff4",
  secondary: "#b0b7c4",
  dim:       "#7e8798",
  muted:     "#5b6679",
  border:    "#475264",
} as const;

const AGENT_COLORS = [C.cyan, C.purple, C.orange, C.pink, C.green, C.yellow] as const;
const SIGILS       = ["◆", "▲", "●", "■", "★", "◉", "◈", "▸"] as const;

// ── Banner ───────────────────────────────────────────────────────────────────
// Figlet "slant" font, colored with an amber → gold gradient per line.

// Each banner line is an array of { text, color } segments for multi-color rendering.
type BannerSegment = { text: string; color: string };
const AMB = "#fbbf24";  // amber/yellow
const WNG = "#e0e7ee";  // wings (white membrane)
const BLK = "#3a3a4a";  // wing veins (dark)

const BANNER: BannerSegment[][] = [
  [
    { text: "               _                      ", color: "#ffb347" },
    { text: "\\ ", color: BLK },
    { text: "\\  ", color: WNG },
  ],
  [
    { text: "  ____ _____  (_)___ ________  __      ", color: "#ffa733" },
    { text: "\\ ", color: WNG },
    { text: "\\ ", color: BLK },
    { text: "\\ ", color: WNG },
  ],
  [
    { text: " / __ `/ __ \\/ / __ `/ ___/ / / /      ", color: "#ff9b1f" },
    { text: "(o o)", color: AMB },
  ],
  [
    { text: "/ /_/ / /_/ / / /_/ / /  / /_/ /       ", color: "#ff8f0b" },
    { text: ")=BzZz=(", color: AMB },
  ],
  [
    { text: "\\__,_/ .___/_/\\__,_/_/   \\__, /        ", color: "#f7a600" },
    { text: "/ ", color: WNG },
    { text: "/ ", color: BLK },
    { text: "/ ", color: WNG },
  ],
  [
    { text: "    /_/                 /____/        ", color: "#f0c000" },
    { text: "/ ", color: BLK },
    { text: "/ ", color: WNG },
    { text: "/  ", color: BLK },
  ],
];

// ── Slash commands ────────────────────────────────────────────────────────────

interface SlashParam {
  label: string;                             // display hint: "name", "mode", etc.
  completions?: string[] | "participants";   // static values, dynamic lookup, or undefined (hint only)
}

interface SlashCommand {
  name: string;
  description: string;
  adminOnly?: boolean;
  params?: SlashParam[];
}

const ENGAGEMENT_MODES = [
  "everyone", "people", "agents",
  "standby-everyone", "standby-people", "standby-agents",
];

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help",    description: "Show commands" },
  { name: "/who",     description: "List participants" },
  { name: "/leave",   description: "Disconnect and exit" },
  { name: "/share",   description: "Generate share links" },
  { name: "/kick",    description: "Remove a participant", adminOnly: true, params: [
    { label: "name", completions: "participants" },
  ]},
  { name: "/mute",    description: "Make read-only (guest)", adminOnly: true, params: [
    { label: "name", completions: "participants" },
  ]},
  { name: "/unmute",  description: "Restore to member", adminOnly: true, params: [
    { label: "name", completions: "participants" },
  ]},
  { name: "/setmode", description: "Set engagement mode", adminOnly: true, params: [
    { label: "name", completions: "participants" },
    { label: "mode", completions: ENGAGEMENT_MODES },
  ]},
  { name: "/ping",   description: "Ping a participant", params: [
    { label: "name", completions: "participants" },
  ]},
  { name: "/tunnel", description: "Start a cloudflared tunnel", adminOnly: true },
  { name: "/sound",  description: "Toggle notification sounds" },
];

const CMD_DISPLAY_COL = 26; // width for command + params display column


// ── Types ─────────────────────────────────────────────────────────────────────

export type DisplayEvent =
  | { id: string; ts: string; kind: "message"; senderName: string; senderType: "human" | "agent"; isSelf: boolean; content: string; replyToName?: string }
  | { id: string; ts: string; kind: "join";    name: string; participantType: "human" | "agent" }
  | { id: string; ts: string; kind: "leave";   name: string; participantType: "human" | "agent" }
  | { id: string; ts: string; kind: "mode";    mode: string }
  | { id: string; ts: string; kind: "ping";    pingerName: string }
  | { id: string; ts: string; kind: "system";  content: string };

export interface TUIHandle {
  push(event: DisplayEvent): void;
  toggleSound(): boolean;
  setBusy(name: string): void;
  setIdle(name: string): void;
  setStale(name: string): void;
  setAgentNames(names: string[]): void;
  setParticipants(names: string[]): void;
  stop(): void;
}

export interface TUIOptions {
  roomName: string;
  onSend?(content: string): void;
  onCtrlC?(): void;
  readOnly?: boolean;
  isAdmin?: boolean;
  soundEnabled?: boolean;
}

// ── Identity (seed → color + sigil) ──────────────────────────────────────────

function seedHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function makeIdentityAssigner(): (name: string) => { color: string; sigil: string } {
  const map = new Map<string, { color: string; sigil: string }>();
  let colorIdx = 0;
  return (name: string) => {
    if (!map.has(name)) {
      const h = seedHash(name);
      map.set(name, {
        color: AGENT_COLORS[colorIdx++ % AGENT_COLORS.length],
        sigil: SIGILS[h % SIGILS.length],
      });
    }
    return map.get(name)!;
  };
}

// ── Word wrap ─────────────────────────────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
  if (width < 10) width = 10;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) { lines.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/( +)/)) {
      if (line.length + word.length > width && line.length > 0) {
        lines.push(line);
        line = word.replace(/^ +/, ""); // trim leading spaces on new line
      } else {
        line += word;
      }
    }
    if (line.length > 0) lines.push(line);
  }
  if (lines.length === 0) lines.push("");
  return lines;
}

// ── Styled content (highlight @mentions) ──────────────────────────────────────

function StyledContent({
  text,
  contentColor,
  identify,
}: {
  text: string;
  contentColor: string;
  identify: (n: string) => { color: string; sigil: string };
}) {
  // Split on @mention patterns, highlight them
  const parts: React.ReactNode[] = [];
  const pattern = /@([a-zA-Z0-9_-]+)/g;
  let lastIdx = 0;
  let match;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    // Text before the mention
    if (match.index > lastIdx) {
      parts.push(<Text key={key++} color={contentColor}>{text.slice(lastIdx, match.index)}</Text>);
    }
    // The @mention itself — use the mentioned name's color
    const mentionName = match[1];
    const { color } = identify(mentionName);
    parts.push(<Text key={key++} color={color} bold>{"@"}{mentionName}</Text>);
    lastIdx = match.index + match[0].length;
  }

  // Remaining text
  if (lastIdx < text.length) {
    parts.push(<Text key={key++} color={contentColor}>{text.slice(lastIdx)}</Text>);
  }

  if (parts.length === 0) {
    return <Text color={contentColor}>{text}</Text>;
  }

  return <>{parts}</>;
}

// ── Reply whispers ────────────────────────────────────────────────────────────
// Tiny phrases that precede a reply-to name. Rotated for personality.

const REPLY_WHISPERS = [
  "re:", "↩", "∿∿", "⤷", "↫", "«", "↳", "⟲", "∿", "⮑",
];

function pickWhisper(messageId: string): string {
  let h = 0;
  for (let i = 0; i < messageId.length; i++) h = ((h << 5) - h + messageId.charCodeAt(i)) | 0;
  return REPLY_WHISPERS[Math.abs(h) % REPLY_WHISPERS.length];
}

// ── Event line ────────────────────────────────────────────────────────────────

const NAME_COL = 12;

function EventLine({
  event,
  identify,
  cols,
  zebra,
}: {
  event: DisplayEvent;
  identify: (n: string) => { color: string; sigil: string };
  cols: number;
  zebra?: boolean;
}) {
  const ts = <Text color={C.muted}>{event.ts}{"  "}</Text>;

  // ── Message ──
  if (event.kind === "message") {
    const { color, sigil } = identify(event.senderName);
    const isSelf     = event.isSelf;
    const nameColor  = isSelf ? C.text : event.senderType === "agent" ? color : C.secondary;
    const sigilColor = isSelf ? C.dim  : event.senderType === "agent" ? color : C.dim;
    const sigilChar  = isSelf ? "›" : event.senderType === "agent" ? sigil : "·";
    const contentColor = isSelf ? C.text : zebra ? "#d0d5de" : C.secondary;

    // Border color: sender's color for agents, dim for self, muted for other humans
    const borderColor = isSelf ? C.border : event.senderType === "agent" ? color : C.dim;

    // Box eats ~4 cols (2 border + 2 padding). Inner content width:
    const boxChrome = 4; // │ + space + space + │
    const innerWidth = Math.max(10, cols - 2 - boxChrome); // -2 for outer paddingX

    const wrapped = wordWrap(event.content, innerWidth);

    // Reply indicator — subtle tag in header. Mentions are already
    // highlighted in content by StyledContent, no separate indicator needed.
    const replyTag = event.replyToName
      ? <><Text color={C.dim}>{"  ↩ "}</Text><Text color={C.secondary}>{event.replyToName}</Text></>
      : null;

    return (
      <Box paddingX={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={borderColor}
          paddingX={1}
          width={cols - 2}
        >
          {/* Header: timestamp + sigil + name (+ reply tag) */}
          <Box>
            {ts}
            <Text color={sigilColor}>{sigilChar}{" "}</Text>
            <Text color={nameColor} bold={isSelf}>{event.senderName}</Text>
            {replyTag}
          </Box>
          {/* Content */}
          {wrapped.map((line, i) => (
            <Box key={i}>
              <Text wrap="truncate">
                <StyledContent text={line} contentColor={contentColor} identify={identify} />
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  // ── Join ──
  if (event.kind === "join") {
    const isAgent = event.participantType === "agent";
    const { color, sigil } = isAgent ? identify(event.name) : { color: C.dim, sigil: "·" };
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={isAgent ? color : C.dim}>{sigil}{" "}</Text>
        <Text color={isAgent ? color : C.dim}>{event.name}</Text>
        <Text color={C.green}>{" joined"}</Text>
      </Box>
    );
  }

  // ── Leave ──
  if (event.kind === "leave") {
    const isAgent = event.participantType === "agent";
    const { color: nameColor } = isAgent ? identify(event.name) : { color: C.muted };
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={C.muted}>{"· "}</Text>
        <Text color={nameColor}>{event.name}</Text>
        <Text color={C.danger}>{" left"}</Text>
      </Box>
    );
  }

  // ── Mode change ──
  if (event.kind === "mode") {
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={C.dim}>{"mode → "}</Text>
        <Text color={C.yellow} bold>{event.mode}</Text>
      </Box>
    );
  }

  // ── Ping notification ──
  if (event.kind === "ping") {
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={C.yellow}>{"🔔 "}</Text>
        <Text color={C.yellow} bold>{event.pingerName}</Text>
        <Text color={C.yellow}>{" pinged you."}</Text>
      </Box>
    );
  }

  // ── System message (slash command output) ──
  if (event.kind === "system") {
    return (
      <Box paddingX={1}>
        {ts}
        <Text color={C.dim}>{"  "}</Text>
        <Text color={C.secondary}>{event.content}</Text>
      </Box>
    );
  }

  return null;
}

// ── Internal bridge ───────────────────────────────────────────────────────────

interface AppHandle {
  push: (event: DisplayEvent) => void;
  setAgentNames: (names: string[]) => void;
  setParticipants: (names: string[]) => void;
  toggleSound: () => boolean;
  setBusy: (name: string) => void;
  setIdle: (name: string) => void;
  setStale: (name: string) => void;
}

// ── App ───────────────────────────────────────────────────────────────────────

type StaticEntry = { id: string; event?: DisplayEvent; zebra?: boolean };

function App({
  roomName,
  onSend,
  onCtrlC,
  onReady,
  readOnly,
  isAdmin,
  initialSound = true,
}: {
  roomName: string;
  onSend?: (content: string) => void;
  onCtrlC?: () => void;
  onReady: (handle: AppHandle) => void;
  readOnly?: boolean;
  isAdmin?: boolean;
  initialSound?: boolean;
}) {
  const [events,        setEvents]        = useState<DisplayEvent[]>([]);
  const [agentNames,    setAgentNames]    = useState<string[]>([]);
  const [participants,  setParticipants]  = useState<string[]>([]);
  const [input,         setInput]         = useState("");
  const [cursorPos,     setCursorPos]     = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [soundEnabled,  setSoundEnabled]  = useState(initialSound);
  const [busyAgents,    setBusyAgents]    = useState<Set<string>>(new Set());
  const [staleAgents,   setStaleAgents]   = useState<Set<string>>(new Set());
  const soundRef = useRef(initialSound);
  const busyRef  = useRef<Set<string>>(new Set());
  const staleRef = useRef<Set<string>>(new Set());
  const busyTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const { stdout } = useStdout();
  const identify   = useMemo(makeIdentityAssigner, []);

  // Atomic input + cursor update
  const setInputAt = useCallback((newInput: string, newPos: number) => {
    setInput(newInput);
    setCursorPos(Math.max(0, Math.min(newPos, newInput.length)));
  }, []);

  // Clamp cursor when input changes externally
  useEffect(() => { setCursorPos(p => Math.min(p, input.length)); }, [input]);

  // Paste batching — buffer rapid chars and flush as one insert
  const pasteBuffer = useRef({ chars: "", timer: null as NodeJS.Timeout | null, pos: 0 });
  // Track last char time for paste-vs-submit heuristic
  const lastCharTime = useRef(0);

  const push = useCallback((event: DisplayEvent) => {
    // Bell for incoming messages (not self) and pings
    const shouldBell =
      event.kind === "ping" ||
      (event.kind === "message" && !event.isSelf);
    if (shouldBell && soundRef.current && stdout.isTTY) stdout.write("\x07");
    setEvents((prev) => [...prev, event]);
  }, [stdout]);

  const toggleSound = useCallback((): boolean => {
    const next = !soundRef.current;
    soundRef.current = next;
    setSoundEnabled(next);
    return next;
  }, []);

  const STALE_TIMEOUT = 5 * 60_000; // 5min before busy → stale

  const setBusy = useCallback((name: string) => {
    busyRef.current.add(name);
    staleRef.current.delete(name);
    setBusyAgents(new Set(busyRef.current));
    setStaleAgents(new Set(staleRef.current));
    // Clear existing timer and start a new one
    const existing = busyTimers.current.get(name);
    if (existing) clearTimeout(existing);
    busyTimers.current.set(name, setTimeout(() => {
      if (busyRef.current.has(name)) {
        staleRef.current.add(name);
        setStaleAgents(new Set(staleRef.current));
      }
    }, STALE_TIMEOUT));
  }, []);

  const setIdle = useCallback((name: string) => {
    busyRef.current.delete(name);
    staleRef.current.delete(name);
    setBusyAgents(new Set(busyRef.current));
    setStaleAgents(new Set(staleRef.current));
    const timer = busyTimers.current.get(name);
    if (timer) { clearTimeout(timer); busyTimers.current.delete(name); }
  }, []);

  const setStale = useCallback((name: string) => {
    staleRef.current.add(name);
    setStaleAgents(new Set(staleRef.current));
  }, []);

  useEffect(() => {
    onReady({ push, setAgentNames, setParticipants, toggleSound, setBusy, setIdle, setStale });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Note: no resize handler — Ink's <Static> items are already committed to the
  // terminal buffer. Forcing a re-render on resize causes cursor position
  // miscalculation and screen corruption. The divider width updates naturally
  // on the next state change (new event, input change, etc.).

  // ── Slash command suggestions ──────────────────────────────────────────────

  type SuggestionItem =
    | { kind: "command"; cmd: SlashCommand; insert: string }
    | { kind: "param";   value: string;     insert: string }
    | { kind: "mention"; value: string;     insert: string };

  const suggestionState = useMemo((): { items: SuggestionItem[]; ghostHint: string } => {
    // @mention detection — match @partial at cursor position
    const textBeforeCursor = input.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9_-]*)$/);
    if (mentionMatch && participants.length > 0) {
      const prefix = mentionMatch[1].toLowerCase();
      const candidates = ["all", ...participants.filter((p) => p.toLowerCase() !== "all")];
      const filtered = candidates.filter((p) => p.toLowerCase().startsWith(prefix));
      if (filtered.length > 0) {
        const before = input.slice(0, mentionMatch.index!);
        const after = input.slice(cursorPos);
        const items: SuggestionItem[] = filtered.map((p) => ({
          kind: "mention" as const,
          value: p,
          insert: before + "@" + p + " " + after,
        }));
        const ghostHint = prefix.length === 0 ? "" : (filtered[0].slice(prefix.length));
        return { items, ghostHint };
      }
    }

    if (!input.startsWith("/")) return { items: [], ghostHint: "" };

    const spaceIdx = input.indexOf(" ");

    // Phase 1: completing command name (no space yet)
    if (spaceIdx === -1) {
      const prefix = input.toLowerCase();
      const items: SuggestionItem[] = SLASH_COMMANDS
        .filter((cmd) => {
          if (cmd.adminOnly && !isAdmin) return false;
          return cmd.name.startsWith(prefix);
        })
        .map((cmd) => ({
          kind: "command" as const,
          cmd,
          insert: cmd.name + " ",
        }));
      return { items, ghostHint: "" };
    }

    // Phase 2: completing params
    const cmdName = input.slice(0, spaceIdx).toLowerCase();
    const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName && (!c.adminOnly || isAdmin));
    if (!cmd?.params) return { items: [], ghostHint: "" };

    const rest = input.slice(spaceIdx + 1);
    const words = rest.split(/\s+/);
    const hasTrailingSpace = rest.endsWith(" ") || rest === "";
    const completedCount = hasTrailingSpace
      ? words.filter(Boolean).length
      : Math.max(0, words.length - 1);
    const currentPrefix = hasTrailingSpace ? "" : (words[words.length - 1] ?? "").toLowerCase();
    const paramIdx = completedCount;

    // All params filled
    if (paramIdx >= cmd.params.length) return { items: [], ghostHint: "" };

    const param = cmd.params[paramIdx];

    // Ghost hint: remaining unfilled params (skip current if partially typed)
    const ghostStart = currentPrefix ? paramIdx + 1 : paramIdx;
    const ghostHint = cmd.params.slice(ghostStart).map((p) => `<${p.label}>`).join(" ");

    // No completions defined — hint only
    if (!param.completions) return { items: [], ghostHint };

    const values = param.completions === "participants" ? participants : param.completions;
    const filtered = currentPrefix
      ? values.filter((v) => v.toLowerCase().startsWith(currentPrefix))
      : values;

    // Build insert string: full command up to current param + selected value
    const completedWords = words.slice(0, completedCount).filter(Boolean);
    const base = cmdName + (completedWords.length ? " " + completedWords.join(" ") : "") + " ";

    const items: SuggestionItem[] = filtered.map((v) => ({
      kind: "param" as const,
      value: v,
      insert: base + v + " ",
    }));

    return { items, ghostHint };
  }, [input, cursorPos, isAdmin, participants]);

  const suggestions = suggestionState.items;

  // Reset selection when input changes (arrow keys don't change input)
  useEffect(() => { setSelectedIndex(0); }, [input]);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  // Single useInput handles everything — no TextInput, no dual-handler conflicts.

  useInput((char, key) => {
    if (key.ctrl && char === "c") { onCtrlC?.(); return; }
    if (readOnly || !onSend) return;

    // Suggestion navigation
    if (suggestions.length > 0) {
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (key.return || key.tab) {
        const picked = suggestions[selectedIndex];
        if (!picked) return;
        // No-param command + Enter → submit directly
        if (key.return && picked.kind === "command" && !picked.cmd.params) {
          onSend(picked.cmd.name);
          setInputAt("", 0);
          return;
        }
        setInputAt(picked.insert, picked.insert.length);
        return;
      }
      if (key.escape) {
        setInputAt("", 0);
        return;
      }
    }

    // Left/right arrow — cursor navigation
    if (key.leftArrow) {
      setCursorPos((p) => Math.max(0, p - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorPos((p) => Math.min(p + 1, input.length));
      return;
    }

    // Ctrl+A → home, Ctrl+E → end
    if (key.ctrl && char === "a") {
      setCursorPos(0);
      return;
    }
    if (key.ctrl && char === "e") {
      setCursorPos(input.length);
      return;
    }

    // Ctrl+W → delete word backward
    if (key.ctrl && char === "w") {
      if (cursorPos === 0) return;
      let pos = cursorPos - 1;
      // Skip trailing spaces
      while (pos > 0 && input[pos] === " ") pos--;
      // Skip word chars
      while (pos > 0 && input[pos - 1] !== " ") pos--;
      setInputAt(input.slice(0, pos) + input.slice(cursorPos), pos);
      return;
    }

    // Option+Enter → newline at cursor
    if (key.return && key.meta) {
      setInputAt(input.slice(0, cursorPos) + "\n" + input.slice(cursorPos), cursorPos + 1);
      return;
    }

    // Enter → submit (with paste heuristic: if <10ms since last char, treat as pasted newline)
    if (key.return) {
      const now = Date.now();
      if (now - lastCharTime.current < 10) {
        // Likely a pasted newline — insert instead of submitting
        setInputAt(input.slice(0, cursorPos) + "\n" + input.slice(cursorPos), cursorPos + 1);
        lastCharTime.current = now;
        return;
      }
      // Flush any pending paste buffer before submit
      if (pasteBuffer.current.timer) {
        clearTimeout(pasteBuffer.current.timer);
        const batch = pasteBuffer.current.chars;
        const bPos = pasteBuffer.current.pos;
        pasteBuffer.current = { chars: "", timer: null, pos: 0 };
        if (batch) {
          const newInput = input.slice(0, bPos) + batch + input.slice(bPos);
          const content = newInput.trim();
          if (content) onSend(content);
          setInputAt("", 0);
          return;
        }
      }
      const content = input.trim();
      if (content) onSend(content);
      setInputAt("", 0);
      return;
    }

    // Backspace — delete at cursor position
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setInputAt(input.slice(0, cursorPos - 1) + input.slice(cursorPos), cursorPos - 1);
      }
      return;
    }

    // Ignore remaining special keys
    if (key.ctrl || key.meta || key.escape || key.tab ||
        key.upArrow || key.downArrow) {
      return;
    }

    // Regular character — batch for paste performance
    if (char) {
      lastCharTime.current = Date.now();
      const buf = pasteBuffer.current;
      if (buf.timer === null) {
        buf.pos = cursorPos;
      }
      buf.chars += char;
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(() => {
        const batch = buf.chars;
        const bPos = buf.pos;
        pasteBuffer.current = { chars: "", timer: null, pos: 0 };
        setInput((prev) => {
          const newInput = prev.slice(0, bPos) + batch + prev.slice(bPos);
          setCursorPos(bPos + batch.length);
          return newInput;
        });
      }, 5);
    }
  });

  const cols = stdout.columns ?? 80;

  // Static items: banner (rendered once) + events (appended over time)
  const entries: StaticEntry[] = useMemo(() => {
    let msgIdx = 0;
    return [{ id: "__banner__" }, ...events.map((e) => {
      const isMsg = e.kind === "message" && !e.isSelf;
      const entry: StaticEntry = { id: e.id, event: e, zebra: isMsg ? msgIdx % 2 === 1 : undefined };
      if (isMsg) msgIdx++;
      return entry;
    })];
  }, [events]);

  return (
    <>
      {/* Permanent output — rendered once, selectable terminal text */}
      <Static items={entries}>
        {(entry) => {
          if (!entry.event) {
            return (
              <Box key={entry.id} flexDirection="column" paddingX={2} paddingTop={1} paddingBottom={1}>
                {BANNER.map((segments, i) => (
                  <Text key={i}>{segments.map((s, j) => (
                    <Text key={j} color={s.color}>{s.text}</Text>
                  ))}</Text>
                ))}
                <Text color={C.muted} italic>{"  ah — it's not a sad alien, it's a bee"}</Text>
                <Text>{" "}</Text>
                <Text>
                  <Text color={C.dim}>{"  room  "}</Text>
                  <Text color={C.cyan} bold>{roomName}</Text>
                </Text>
              </Box>
            );
          }
          return <EventLine key={entry.id} event={entry.event} identify={identify} cols={cols} zebra={entry.zebra} />;
        }}
      </Static>

      {/* Dynamic footer — only this area repaints */}
      <Box paddingX={1}>
        <Text color={C.orange}>{"─"}</Text>
        <Text color={C.border}>{"─".repeat(Math.max(0, cols - 4))}</Text>
        <Text color={C.yellow}>{"─"}</Text>
      </Box>
      {agentNames.length > 0 && (
        <Box paddingX={1} flexWrap="wrap">
          {agentNames.map((name, i) => {
            const { sigil } = identify(name);
            const stale = staleAgents.has(name);
            const busy = busyAgents.has(name);
            const nameColor = stale ? C.muted : busy ? C.yellow : C.green;
            return (
              <React.Fragment key={name}>
                {i > 0 && <Text color={C.border}>{" · "}</Text>}
                <Text color={nameColor}>{sigil}{" "}{name}</Text>
                {stale && <Text color={C.muted}>{" zzz"}</Text>}
              </React.Fragment>
            );
          })}
        </Box>
      )}
      {readOnly || !onSend ? (
        <Box paddingX={1}>
          <Text color={C.muted}>{"  watching as guest"}</Text>
        </Box>
      ) : (
        <Box paddingX={1} flexDirection="column">
          {/* Render each line with cursor at correct position */}
          {(() => {
            const lines = (input || "").split("\n");
            // Find which line the cursor is on and the column within that line
            let charsSoFar = 0;
            let cursorLine = lines.length - 1;
            let cursorCol = 0;
            for (let i = 0; i < lines.length; i++) {
              const lineEnd = charsSoFar + lines[i].length;
              if (cursorPos <= lineEnd) {
                cursorLine = i;
                cursorCol = cursorPos - charsSoFar;
                break;
              }
              charsSoFar += lines[i].length + 1; // +1 for \n
            }

            return lines.map((line, i) => (
              <Box key={i} width={Math.max(0, cols - 2)}>
                <Text color={C.cyan} bold>{i === 0 ? "› " : "  "}</Text>
                <Text wrap="wrap">
                  {i === cursorLine ? (
                    <>
                      <Text>{line.slice(0, cursorCol)}</Text>
                      <Text inverse>{cursorCol < line.length ? line[cursorCol] : " "}</Text>
                      <Text>{cursorCol < line.length ? line.slice(cursorCol + 1) : ""}</Text>
                    </>
                  ) : (
                    line
                  )}
                  {i === lines.length - 1 && cursorPos === input.length && suggestionState.ghostHint !== "" && (
                    <Text color={C.muted}>{suggestionState.ghostHint}</Text>
                  )}
                </Text>
              </Box>
            ));
          })()}
        </Box>
      )}
      {/* Slash command suggestions — below input */}
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {suggestions.map((s, i) => {
            const selected = i === selectedIndex;
            if (s.kind === "command") {
              const paramHint = s.cmd.params
                ? " " + s.cmd.params.map((p) => `<${p.label}>`).join(" ")
                : "";
              const display = s.cmd.name + paramHint;
              return (
                <Box key={s.cmd.name}>
                  <Text color={selected ? C.cyan : C.muted}>{selected ? "› " : "  "}</Text>
                  <Text>
                    <Text color={selected ? C.cyan : C.secondary} bold={selected}>
                      {s.cmd.name}
                    </Text>
                    <Text color={C.muted}>
                      {paramHint.padEnd(CMD_DISPLAY_COL - display.length + paramHint.length)}
                    </Text>
                  </Text>
                  <Text color={C.dim}>{s.cmd.description}</Text>
                </Box>
              );
            }
            return (
              <Box key={s.value}>
                <Text color={selected ? C.cyan : C.muted}>{selected ? "› " : "  "}</Text>
                {s.kind === "mention" && <Text color={C.dim}>{"@"}</Text>}
                <Text color={selected ? C.cyan : C.secondary} bold={selected}>{s.value}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </>
  );
}

// ── startTUI ──────────────────────────────────────────────────────────────────

export function startTUI(opts: TUIOptions): TUIHandle {
  let handle: AppHandle | null = null;
  const queue: DisplayEvent[] = [];

  const onReady = (h: AppHandle) => {
    handle = h;
    for (const event of queue.splice(0)) h.push(event);
  };

  const { unmount } = render(
    <App
      roomName={opts.roomName}
      onSend={opts.onSend}
      onCtrlC={opts.onCtrlC}
      onReady={onReady}
      readOnly={opts.readOnly}
      isAdmin={opts.isAdmin}
      initialSound={opts.soundEnabled ?? true}
    />,
    { exitOnCtrlC: false },
  );

  return {
    push(event) {
      if (handle) handle.push(event);
      else queue.push(event);
    },
    setAgentNames(names) {
      handle?.setAgentNames(names);
    },
    setParticipants(names) {
      handle?.setParticipants(names);
    },
    toggleSound() {
      return handle?.toggleSound() ?? false;
    },
    setBusy(name) {
      handle?.setBusy(name);
    },
    setIdle(name) {
      handle?.setIdle(name);
    },
    setStale(name) {
      handle?.setStale(name);
    },
    stop() {
      unmount();
    },
  };
}
