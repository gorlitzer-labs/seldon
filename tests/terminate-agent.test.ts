/**
 * Tests for terminateLocalAgent — the half of /kick that stops the agent
 * rather than just its seat in the room.
 */

import { describe, test, expect } from "vitest";
import { seatsToEvict, terminateLocalAgent, type TerminateDeps } from "../src/cli/terminate-agent.js";
import type { AgentRuntime, AgentSession } from "../src/cli/agent-session.js";

function deps(
  sessions: Partial<Record<AgentRuntime, AgentSession[]>>,
  opts: { alive?: boolean } = {},
): TerminateDeps & { killed: number[]; tmuxKilled: string[]; cleared: string[] } {
  const killed: number[] = [];
  const tmuxKilled: string[] = [];
  const cleared: string[] = [];
  return {
    killed, tmuxKilled, cleared,
    list: (r) => sessions[r] ?? [],
    alive: () => opts.alive ?? true,
    kill: (pid) => { killed.push(pid); },
    killTmux: (s) => { tmuxKilled.push(s); },
    clear: (r, n) => { cleared.push(`${r}:${n}`); },
  };
}

const codexAgent: AgentSession = {
  runtime: "codex", agentName: "aztraboy", pid: 4242, tmuxSession: "apiary_aztraboy",
} as AgentSession;

describe("terminateLocalAgent", () => {
  test("stops the process AND the tmux session of a local agent", () => {
    // The bug: /kick severed the room connection and left the runtime alive,
    // still reasoning about work it could no longer tell anyone about.
    const d = deps({ codex: [codexAgent] });
    const out = terminateLocalAgent("aztraboy", d);

    expect(out).toMatchObject({ stopped: true, runtime: "codex", pid: 4242 });
    expect(d.killed).toEqual([4242]);
    expect(d.tmuxKilled).toEqual(["apiary_aztraboy"]);
    expect(d.cleared).toEqual(["codex:aztraboy"]);
  });

  test("leaves a remote agent alone — a room cannot kill someone else's process", () => {
    // No local record means the agent joined from another machine. The room's
    // only honest move is to disconnect it.
    const d = deps({ codex: [codexAgent] });
    const out = terminateLocalAgent("someone-elses-agent", d);

    expect(out).toEqual({ stopped: false, reason: "not-local" });
    expect(d.killed).toEqual([]);
    expect(d.tmuxKilled).toEqual([]);
    expect(d.cleared).toEqual([]);
  });

  test("clears the record of an agent that already died, without signalling", () => {
    // A record outliving its process is paperwork, not an agent. Leaving it
    // on disk keeps the name looking taken.
    const d = deps({ codex: [codexAgent] }, { alive: false });
    const out = terminateLocalAgent("aztraboy", d);

    expect(out).toEqual({ stopped: false, reason: "already-exited" });
    expect(d.killed).toEqual([]);
    expect(d.cleared).toEqual(["codex:aztraboy"]);
  });

  test("finds the agent whichever runtime it was started with", () => {
    const claudeAgent = {
      runtime: "claude", agentName: "fableboy", pid: 77, tmuxSession: "apiary_fableboy",
    } as AgentSession;
    const d = deps({ claude: [claudeAgent], codex: [codexAgent] });

    expect(terminateLocalAgent("fableboy", d)).toMatchObject({ stopped: true, runtime: "claude", pid: 77 });
    expect(terminateLocalAgent("aztraboy", d)).toMatchObject({ stopped: true, runtime: "codex", pid: 4242 });
  });

  test("a process that raced its own exit does not throw", () => {
    // SIGTERM to a pid that just exited throws ESRCH. The kick must still
    // complete and still clear the record.
    const d = deps({ codex: [codexAgent] });
    const out = terminateLocalAgent("aztraboy", {
      ...d,
      kill: () => { throw new Error("ESRCH"); },
    });
    expect(out).toMatchObject({ stopped: true });
  });
});

describe("seatsToEvict", () => {
  // The exact roster observed in the shipyard room: one live aztraboy, one
  // ghost, both answering to the same name. /kick removed the live one.
  const roster = [
    { id: "agent_933679aa", name: "aztraboy", type: "agent" as const },
    { id: "agent_531f6da2", name: "fableboy", type: "agent" as const },
    { id: "human_8a3cf2ce", name: "Franco", type: "human" as const },
  ];

  test("a rejoining agent evicts its own previous seat", () => {
    expect(seatsToEvict(roster, { name: "aztraboy", type: "agent" }))
      .toEqual([{ id: "agent_933679aa", name: "aztraboy", type: "agent" }]);
  });

  test("it evicts EVERY stale seat, not just the first", () => {
    // Two ghosts had already accumulated once; a fix that drops one leaves
    // the ambiguity in place.
    const withTwoGhosts = [
      { id: "agent_old1", name: "aztraboy", type: "agent" as const },
      { id: "agent_old2", name: "aztraboy", type: "agent" as const },
      ...roster.slice(1),
    ];
    expect(seatsToEvict(withTwoGhosts, { name: "aztraboy", type: "agent" }).map((s) => s.id))
      .toEqual(["agent_old1", "agent_old2"]);
  });

  test("a new agent name evicts nobody", () => {
    expect(seatsToEvict(roster, { name: "newboy", type: "agent" })).toEqual([]);
  });

  test("it never evicts another agent", () => {
    const out = seatsToEvict(roster, { name: "aztraboy", type: "agent" });
    expect(out.map((s) => s.name)).not.toContain("fableboy");
  });

  test("two people may share a display name — humans are never evicted", () => {
    // One agent name is one runtime by construction. Two humans called Franco
    // are two people, and throwing one out of the room would be wrong.
    const twoFrancos = [...roster, { id: "human_other", name: "Franco", type: "human" as const }];
    expect(seatsToEvict(twoFrancos, { name: "Franco", type: "human" })).toEqual([]);
  });

  test("a human joining does not evict an agent of the same name", () => {
    expect(seatsToEvict(roster, { name: "aztraboy", type: "human" })).toEqual([]);
  });
});
