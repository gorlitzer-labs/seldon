// factory box — run an agent with its permissions skipped, inside a box.
//
// Franco skips permissions on almost everything, because an agent that stops to
// ask cannot work a shift. On the host that hands it ~/.ssh, ~/.aws, the gh
// token, both AI logins and every repo on the machine. Nothing has gone wrong
// yet; that is luck. This moves the same bypass somewhere it cannot cost much.
//
// The box is deliberately boring: one repo mounted, no host home, dropped
// capabilities, a memory and process ceiling, and NO credentials unless asked
// for by name. The agent inside runs fully unrestricted, which is the point —
// the restriction is the wall, not the leash.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import { c, say, err } from "./lib/log.mjs";

export const IMAGE = "factory-agentbox";

/**
 * The box's own home, kept in a docker volume across runs.
 *
 * This is what stops the box asking you to log in every single time. The agent
 * signs in ONCE, inside the box; its tokens land here and are still here on the
 * next run, next week, next reboot. Nothing about that touches the host — this
 * volume is not ~/.codex or ~/.claude, it is the fleet's own home, and it is the
 * whole reason the box can be both credentialed and sealed.
 *
 * It is also the off switch: `docker volume rm factory-agentbox-home` revokes
 * the fleet's access without touching the logins you use yourself.
 */
export const HOME_VOLUME = "factory-agentbox-home";

/**
 * How each harness is told to stop asking permission.
 *
 * Both vendors document these as last resorts for externally sandboxed
 * environments, which is exactly what the box is. Adding a harness is one entry
 * here — nothing else in the box knows or cares which agent is running.
 */
export const HARNESSES = {
  claude: {
    bin: "claude",
    bypass: ["--dangerously-skip-permissions"],
    /** Mounted only with --creds. The one secret the agent must have to work. */
    credPath: ".claude",
  },
  codex: {
    bin: "codex",
    bypass: ["--dangerously-bypass-approvals-and-sandbox"],
    credPath: ".codex",
  },
};

/**
 * Host paths an agent has no business reading, checked by `factory box doctor`.
 *
 * Not a mount list — the box mounts nothing but the repo. This is the list the
 * doctor tries to read from inside, so isolation is demonstrated rather than
 * asserted.
 */
export const HOST_SECRETS = [".ssh", ".aws", ".config/gh", ".codex", ".claude"];

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf-8", ...opts });
}

function dockerAvailable() {
  const r = docker(["info", "--format", "{{.ServerVersion}}"]);
  return r.status === 0;
}

function imageExists() {
  const r = docker(["image", "inspect", IMAGE]);
  return r.status === 0;
}

/** Build the image if it is missing. Cheap after the first time. */
export function ensureImage({ rebuild = false } = {}) {
  if (!rebuild && imageExists()) return;
  const dockerfile = new URL("../agentbox/Dockerfile", import.meta.url).pathname;
  say(c.dim(`  building ${IMAGE}…`));
  const r = docker(["build", "-t", IMAGE, "-f", dockerfile, new URL("../agentbox/", import.meta.url).pathname], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("image build failed");
}

/**
 * Assemble the `docker run` argv.
 *
 * Exported so the tests can read the policy off the command rather than trust a
 * description of it: the mounts, the ceilings and the dropped capabilities are
 * all visible here, and a change to any of them shows up as a failing test.
 */
export function runArgs({
  repo,
  harness = null,
  creds = false,
  memory = "4g",
  cpus = "2",
  pids = "512",
  network = true,
  tty = false,
  home = true,
  command = [],
}) {
  const args = ["run", "--rm"];
  if (tty) args.push("-it");

  // Only the repo. No host home, no dotfiles, nothing else.
  args.push("-v", `${repo}:/work`, "-w", "/work");

  // The box's own home. Persisted so a login survives the container, throwaway
  // under --fresh (which is how the tests prove a cold box really is cold).
  if (home !== false) {
    args.push("-v", `${home === true || home === undefined ? HOME_VOLUME : home}:/home/agent`);
  }

  if (creds) {
    if (!harness) throw new Error("--creds needs --agent, so the box mounts one credential and not a drawer of them");
    const h = HARNESSES[harness];
    const src = resolve(homedir(), h.credPath);
    if (!existsSync(src)) throw new Error(`no credentials at ~/${h.credPath} to mount`);
    // Read-write: both CLIs rotate their own tokens and write them back, and a
    // read-only mount leaves the host holding a token the agent already spent.
    args.push("-v", `${src}:/home/agent/${h.credPath}`);
  }

  args.push(
    "--memory", memory,
    "--cpus", cpus,
    "--pids-limit", pids,
    // An agent never needs to gain privileges it was not started with.
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
  );
  if (!network) args.push("--network", "none");

  args.push(IMAGE);
  if (command.length > 0) {
    args.push(...command);
  } else if (harness) {
    args.push(HARNESSES[harness].bin, ...HARNESSES[harness].bypass);
  } else {
    args.push("bash");
  }
  return args;
}

export async function factoryBox(pos, flags) {
  if (pos[0] === "doctor") return boxDoctor(pos[1], flags);

  if (!dockerAvailable()) throw new Error("docker is not running — start Docker Desktop and try again");

  const repo = resolve(pos[0] ?? process.cwd());
  if (!existsSync(repo)) throw new Error(`no such directory: ${repo}`);

  const harness = typeof flags.agent === "string" ? flags.agent : null;
  if (harness && !HARNESSES[harness]) {
    throw new Error(`unknown agent "${harness}" — known: ${Object.keys(HARNESSES).join(", ")}`);
  }

  ensureImage({ rebuild: flags.rebuild === true });

  const args = runArgs({
    repo,
    harness,
    creds: flags.creds === true,
    memory: typeof flags.memory === "string" ? flags.memory : "4g",
    cpus: typeof flags.cpus === "string" ? flags.cpus : "2",
    network: flags["no-net"] !== true,
    home: flags.fresh === true ? false : true,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    command: flags["--"] ?? [],
  });

  say([
    `${c.honey("📦 box")} ${c.bold(basename(repo))}`,
    `   mounted   ${repo} → /work`,
    `   agent     ${harness ? `${harness} (permissions skipped inside)` : "none — plain shell"}`,
    `   identity  ${flags.creds
      ? c.yellow(`YOUR ~/${HARNESSES[harness].credPath} is mounted — the box can read that credential`)
      : flags.fresh
        ? "throwaway home — you will be asked to log in"
        : `fleet home (volume ${HOME_VOLUME}) — log in once, it sticks`}`,
    `   ceiling   ${typeof flags.memory === "string" ? flags.memory : "4g"} memory · ${typeof flags.cpus === "string" ? flags.cpus : "2"} cpus`,
    "",
  ].join("\n"));

  const r = docker(args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

/**
 * Prove the walls are there.
 *
 * "It runs in a container" is a claim; this is the check. It goes into the box
 * and tries to read each host secret, then reports what it could and could not
 * reach. Run it after any change to the mount policy — a wall nobody has tested
 * is a wall nobody should trust.
 */
export function boxDoctor(dir, flags = {}) {
  if (!dockerAvailable()) throw new Error("docker is not running — start Docker Desktop and try again");
  ensureImage({ rebuild: flags.rebuild === true });

  const repo = resolve(dir ?? process.cwd());

  // Probe the LITERAL host paths, not just $HOME. Checking $HOME alone is very
  // nearly a tautology — the box's home is its own volume, so of course ~/.ssh
  // is not in it. What actually needs proving is that the host's real
  // /Users/<you>/.ssh is not reachable from inside by any mount.
  const hostHome = homedir();
  const probe = HOST_SECRETS
    .map((p) => `if [ -e "$HOME/${p}" ] || [ -e "${hostHome}/${p}" ] || [ -e "/host/${p}" ]; then echo "REACHABLE ${p}"; else echo "sealed    ${p}"; fi`)
    .join("; ");

  const args = runArgs({ repo, command: ["bash", "-lc", `${probe}; echo "---"; ls /work >/dev/null 2>&1 && echo "work mount OK" || echo "work mount MISSING"`] });
  const r = docker(args);
  const out = (r.stdout ?? "") + (r.stderr ?? "");

  const reachable = out.split("\n").filter((l) => l.startsWith("REACHABLE"));
  say([
    `${c.honey("📦 box doctor")}`,
    ...out.trim().split("\n").map((l) => `   ${l.startsWith("REACHABLE") ? c.red(l) : c.dim(l)}`),
    "",
    reachable.length === 0
      ? c.green("   every host secret is sealed off from the box")
      : c.red(`   ${reachable.length} host secret(s) REACHABLE from inside — the box is not sealed`),
  ].join("\n"));
  return reachable.length === 0;
}
