// factory ↔ bifrost: reach a hive that lives on another machine.
//
// bifrost already owns the concept of a "realm" — a remote host on the tailnet,
// defined in ~/.config/bifrost/realms/<name> as REALM_HOST / REALM_USER. Rather
// than invent a second machine registry, factory reads bifrost's. That is the
// integration: one source of truth for "what machines exist", bifrost's.
//
// A hive registered with a realm has its host-coupled operations — is the agent's
// tmux session alive, respawn it if not — run over ssh to that realm instead of
// locally. Everything else (the hive's HTTP health, the seam) already works
// across the tailnet unchanged, because a hive URL is just an address.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const bifrostRealmsDir = () =>
  join(homedir(), ".config", "bifrost", "realms");

/**
 * Parse a bifrost realm file into { host, user }.
 *
 * The file is shell (`REALM_HOST="x"`), but factory is node, so it is read
 * rather than sourced — and read narrowly: only the two keys, quotes stripped,
 * nothing executed. Sourcing an arbitrary file from disk to learn a hostname is
 * exactly the kind of thing that should not be done.
 */
export function parseRealmFile(text) {
  const pick = (key) => {
    // Back-compat with bifrost's own: REALM_* preferred, legacy DEVICE_* fallback.
    for (const k of [`REALM_${key}`, `DEVICE_${key}`]) {
      const m = text.match(new RegExp(`^\\s*${k}=["']?([^"'\\n]+)`, "m"));
      if (m) return m[1].trim();
    }
    return null;
  };
  const host = pick("HOST");
  const user = pick("USER");
  if (!host) return null;
  return { host, user: user || null };
}

/** Resolve a realm name to { host, user } via bifrost's registry, or null. */
export function resolveRealm(name, dir = bifrostRealmsDir()) {
  if (!name) return null;
  // A realm name becomes an ssh target; keep it to the same charset bifrost
  // validates, so a crafted name cannot smuggle a path or an option.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`invalid realm name: ${JSON.stringify(name)}`);
  }
  const file = join(dir, name);
  if (!existsSync(file)) return null;
  return parseRealmFile(readFileSync(file, "utf8"));
}

/** Every realm bifrost knows about, with resolution. */
export function listRealms(dir = bifrostRealmsDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[A-Za-z0-9_-]+$/.test(n)) // skip .DS_Store, "bad name", etc.
    .map((name) => ({ name, ...(resolveRealm(name, dir) || { host: null, user: null }) }))
    .filter((r) => r.host);
}

/**
 * Build the argv to run a command on a realm — or locally when realm is null.
 *
 * Exported and pure so a test reads the policy off the argv: a local hive runs
 * the command verbatim, a realm hive gets it wrapped in ssh with batch options
 * (never prompt, short connect timeout) so a supervisor tick cannot hang on a
 * dead realm. `<user>@<host>` when a user is set, bare host otherwise.
 */
export function runnerArgv(realm, command) {
  if (!realm) return { bin: command[0], args: command.slice(1) };
  const target = realm.user ? `${realm.user}@${realm.host}` : realm.host;
  return {
    bin: "ssh",
    args: [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      target,
      // One string, so the remote shell runs it as one command. Callers pass
      // already-safe tokens (agent names are validated upstream).
      command.join(" "),
    ],
  };
}
