/**
 * The box's mount and privilege policy.
 *
 * `factory box` exists because permissions get skipped on nearly everything, and
 * on the host that means an agent can read ~/.ssh, ~/.aws, the gh token and both
 * AI logins. The wall is entirely in the `docker run` argv, so these tests read
 * the policy off the command itself: if a mount or a ceiling quietly changes,
 * one of these fails rather than the wall silently going away.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { runArgs, HARNESSES, HOME_VOLUME } from "../src/box.mjs";

const REPO = "/Users/someone/Desktop/project";
const mountsOf = (args) => args.filter((a, i) => args[i - 1] === "-v");

describe("what the box mounts", () => {
  test("the repo, and the fleet home, and nothing else", () => {
    const mounts = mountsOf(runArgs({ repo: REPO }));
    assert.deepEqual(mounts, [`${REPO}:/work`, `${HOME_VOLUME}:/home/agent`]);
  });

  test("never the host home", () => {
    const args = runArgs({ repo: REPO }).join(" ");
    assert.ok(!args.includes(`${homedir()}:`), "host home must never be mounted");
    for (const secret of [".ssh", ".aws", ".config/gh"]) {
      assert.ok(!args.includes(`${homedir()}/${secret}`), `${secret} must never be mounted`);
    }
  });

  test("the fleet home is a docker volume, not a host path — that is what keeps a login sealed AND persistent", () => {
    const mounts = mountsOf(runArgs({ repo: REPO }));
    const home = mounts.find((m) => m.endsWith(":/home/agent"));
    assert.ok(!home.startsWith("/"), "a host path here would put the fleet's tokens on the host");
    assert.equal(home, `${HOME_VOLUME}:/home/agent`);
  });

  test("--fresh drops the fleet home, so a cold box really is cold", () => {
    const mounts = mountsOf(runArgs({ repo: REPO, home: false }));
    assert.deepEqual(mounts, [`${REPO}:/work`]);
  });
});

describe("credentials", () => {
  test("mounting your own credentials requires naming the agent, so it is one secret and not a drawer", () => {
    assert.throws(() => runArgs({ repo: REPO, creds: true }), /needs --agent/);
  });
});

describe("privileges and ceilings", () => {
  test("all capabilities dropped and no privilege escalation", () => {
    const args = runArgs({ repo: REPO });
    assert.ok(args.includes("--cap-drop") && args.includes("ALL"));
    assert.ok(args.includes("--security-opt") && args.includes("no-new-privileges"));
  });

  test("memory, cpu and process ceilings are always set", () => {
    const args = runArgs({ repo: REPO });
    for (const flag of ["--memory", "--cpus", "--pids-limit"]) {
      assert.ok(args.includes(flag), `${flag} must be set — a runaway agent should hit a wall, not the laptop`);
    }
  });

  test("--no-net cuts the network off entirely", () => {
    const args = runArgs({ repo: REPO, network: false });
    assert.ok(args.join(" ").includes("--network none"));
  });
});

describe("harnesses", () => {
  test("each known agent is launched with its own permission bypass", () => {
    for (const [name, h] of Object.entries(HARNESSES)) {
      const args = runArgs({ repo: REPO, harness: name });
      assert.ok(args.includes(h.bin), `${name} binary missing`);
      for (const flag of h.bypass) assert.ok(args.includes(flag), `${name} is not running unrestricted inside the box`);
    }
  });

  test("with no agent named it is just a shell — nothing is bypassed by accident", () => {
    const args = runArgs({ repo: REPO });
    assert.equal(args[args.length - 1], "bash");
    for (const h of Object.values(HARNESSES)) {
      for (const flag of h.bypass) assert.ok(!args.includes(flag));
    }
  });
});
