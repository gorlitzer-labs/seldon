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
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runArgs, HARNESSES, HOME_VOLUME, IMAGE, wrapWithSecrets, doctorProbe } from "../src/box.mjs";

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

describe("secrets", () => {
  test("forwards by NAME only — a value must never reach a command line", () => {
    const args = runArgs({ repo: REPO, secrets: ["CF_API_TOKEN", "GITHUB_TOKEN"] });
    // `-e NAME` (no =) tells docker to take it from its own environment. The
    // `-e NAME=value` form would put the secret in argv, where `ps` shows it to
    // anyone on the machine and shell history keeps it.
    assert.ok(args.includes("-e"));
    assert.ok(args.includes("CF_API_TOKEN"));
    assert.ok(!args.some((a) => a.includes("=") && a.includes("CF_API_TOKEN")),
      "a NAME=value pair would leak the secret into argv");
  });

  test("no secrets requested, no -e flags invented", () => {
    const args = runArgs({ repo: REPO });
    assert.equal(args.includes("-e"), false);
  });

  test("docker is run through comb when secrets are wanted, so factory never holds a value", () => {
    const { bin, args } = wrapWithSecrets(["run", "--rm", IMAGE], ["CF_API_TOKEN"]);
    assert.equal(bin, "comb");
    assert.deepEqual(args, ["run", "--with", "CF_API_TOKEN", "--", "docker", "run", "--rm", IMAGE]);
  });

  test("docker is called directly when no secrets are wanted — no needless dependency", () => {
    const { bin, args } = wrapWithSecrets(["run", "--rm", IMAGE], []);
    assert.equal(bin, "docker");
    assert.deepEqual(args, ["run", "--rm", IMAGE]);
  });
});

describe("box doctor", () => {
  // Runs the REAL probe string in a shell: `home` stands in for the box's own $HOME, `hostHome` for
  // the host's home path as seen from inside the box.
  const probe = (home, hostHome) =>
    spawnSync("sh", ["-c", doctorProbe(hostHome)], { encoding: "utf8", env: { ...process.env, HOME: home } }).stdout;
  const tmp = () => mkdtempSync(join(tmpdir(), "box-doctor-"));

  test("the box's own ~/.claude and ~/.codex are not host secrets", () => {
    // After an agent has signed in or run inside the box, its fleet home holds these. Flagging them
    // told every user "the box is not sealed" after first use, when nothing of the host was visible.
    const home = tmp(), nowhere = join(tmp(), "no-such-host-home");
    try {
      for (const d of [".claude", ".codex"]) mkdirSync(join(home, d));
      const out = probe(home, nowhere);
      assert.ok(!out.includes("REACHABLE"), out);
      assert.equal(out.trim().split("\n").length, 5, "all five host secrets are still reported on");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a host secret that really is reachable is still flagged", () => {
    const hostHome = tmp();
    try {
      mkdirSync(join(hostHome, ".ssh"));
      const out = probe(tmp(), hostHome);
      assert.match(out, /REACHABLE .ssh/);
      assert.match(out, /sealed +\.aws/);
    } finally { rmSync(hostHome, { recursive: true, force: true }); }
  });
});

describe("the npm package", () => {
  test("ships the Dockerfile `factory box` builds its image from", () => {
    // box.mjs builds from ../agentbox/. A `files` list without it published a package whose
    // `factory box` failed on first use for everyone who installed from npm.
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const shipped = JSON.parse(r.stdout)[0].files.map((f) => f.path);
    assert.ok(shipped.includes("agentbox/Dockerfile"), `agentbox/Dockerfile is not in the package:\n${shipped.join("\n")}`);
  });
});
