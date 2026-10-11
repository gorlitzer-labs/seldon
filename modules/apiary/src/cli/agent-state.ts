/**
 * Bridge TUI state → the coarse state the room shows.
 *
 * Each bridge already works out what its CLI is doing, in order to decide
 * whether it is safe to inject text. That knowledge never left the runtime, so
 * the room fell back to inferring "working" for every agent whenever anyone
 * spoke — which meant an agent parked on an approval prompt was displayed
 * exactly like one that was thinking. One of those resolves by waiting and the
 * other never does, so they must not look the same.
 */

import type { AgentActivityState } from "../agent/event-processor.js";
import type { CodexTuiState } from "./codex/tmux-bridge.js";
import type { TuiState } from "./claude/tmux-bridge.js";

/**
 * Codex: `approval` is a tool/command confirmation, `blocked` is a sign-in,
 * onboarding or directory-trust screen. Both need a human.
 */
export function codexStateToActivity(state: CodexTuiState): AgentActivityState | undefined {
  switch (state) {
    case "absent":
      // A human has to restart it, which is what "needs you" means. Reporting
      // idle here is how a dead agent sat in the room looking available.
      return "blocked";
    case "approval":
    case "blocked":
      return "blocked";
    case "streaming":
      return "working";
    case "idle":
    case "typing":
      return "idle";
    case "unknown":
    default:
      // Don't report a guess as ground truth — leave the room's inference be.
      return undefined;
  }
}

/**
 * Claude Code: `permission` is a tool-permission prompt, `dialog` a
 * selection/question overlay. Both sit there until a human answers.
 */
export function claudeStateToActivity(state: TuiState): AgentActivityState | undefined {
  switch (state) {
    case "absent":
      return "blocked";
    case "permission":
    case "dialog":
      return "blocked";
    case "streaming":
      return "working";
    case "idle":
    case "typing":
      return "idle";
    case "unknown":
    default:
      return undefined;
  }
}
