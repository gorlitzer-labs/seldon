// `factory state --json` — the machine-readable twin of `board`.
//
// board.mjs computes hive state and formats ANSI in the same pass, so anything
// that is not a terminal has to re-derive it. That means a second parser of the
// Foundation seam living outside this repo, drifting the moment the seam grammar
// changes. This exposes the SAME functions board already calls — readRegistry,
// hiveState, pending — as JSON, so the terminal, a voice assistant and a
// dashboard are three renderers over one state function.
//
// Read-only. Steering still goes through `decide`.
import { say } from "./lib/log.mjs";
import { readRegistry, hiveState } from "./lib/hive.mjs";
import { pending } from "./lib/decisions.mjs";

export async function factoryState(flags) {
  const reg = readRegistry();
  const hives = await Promise.all(reg.map(hiveState));
  const decisions = pending();

  const state = {
    generatedAt: new Date().toISOString(),
    hives: hives.map((h) => ({
      name: h.name,
      dir: h.dir,
      up: h.up,
      queueOpen: h.queueOpen,
      done: h.done,
      facts: h.facts,
      drift: h.drift,
      blockers: h.blockers,
      lanes: h.lanes,
      digest: h.digest,
      needsYou: !h.up || h.drift > 0 || h.blockers > 0,
    })),
    decisions,
    summary: {
      hives: hives.length,
      down: hives.filter((h) => !h.up).length,
      blockers: hives.reduce((n, h) => n + h.blockers, 0),
      drift: hives.reduce((n, h) => n + h.drift, 0),
      queueOpen: hives.reduce((n, h) => n + h.queueOpen, 0),
      pendingDecisions: decisions.length,
      needsYou: hives.filter((h) => !h.up || h.drift > 0 || h.blockers > 0).length
                + decisions.length,
    },
  };

  say(JSON.stringify(state, null, flags.compact ? 0 : 2));
}
