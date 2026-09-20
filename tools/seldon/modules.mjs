// The Seldon stack — the module registry the installer reads.
// One entry per tool: how it ships, what it needs, what it pulls in.

export const MONOREPO = "gorlitzer-labs/seldon";
export const RAW = `https://raw.githubusercontent.com/${MONOREPO}/main`;

/** @typedef {"npm"|"shell"|"python"} Method */

export const MODULES = [
  {
    id: "apiary",
    title: "the conversation",
    blurb: "shared rooms where AI agents talk, coordinate, hand off",
    method: "npm",
    pkg: "@gorlitzer-labs/apiary",
    dir: "modules/apiary",
    bin: "apiary",
    needs: ["node", "tmux"],           // tmux only for the terminal agents, still worth flagging
    requires: [],
    platforms: null,                    // any
  },
  {
    id: "foundation",
    title: "the seam",
    blurb: "the deterministic project workflow beneath it all",
    method: "npm",
    pkg: "@gorlitzer-labs/foundation",
    dir: "modules/foundation",
    bin: "foundation",
    needs: ["node"],
    requires: [],
    platforms: null,
  },
  {
    id: "comb",
    title: "the vault",
    blurb: "keys by name; a leak audit; multi-machine secrets (SOPS + age)",
    method: "npm",
    pkg: "@gorlitzer-labs/comb",
    dir: "modules/comb",
    bin: "comb",
    needs: ["node", "sops", "age"],
    requires: [],
    platforms: null,
  },
  {
    id: "factory",
    title: "the floor",
    blurb: "the 24/7 supervisor — new · watch · board · box · realms",
    method: "npm",
    pkg: "@gorlitzer-labs/factory",
    dir: "modules/factory",
    bin: "factory",
    needs: ["node"],
    requires: ["apiary", "foundation"], // factory needs both on PATH
    platforms: null,
  },
  {
    id: "bifrost",
    title: "the bridge",
    blurb: "tmux + Tailscale; sessions survive; phone access; agent state",
    method: "shell",
    dir: "modules/bifrost",
    installer: "modules/bifrost/install.sh",
    bin: "bifrost",
    needs: ["tmux", "tailscale"],
    requires: [],
    platforms: null,                    // macos / linux / termux
  },
  {
    id: "demerzel",
    title: "the voice",
    blurb: "a fully-local voice you talk to (MLX, Apple silicon)",
    method: "python",
    dir: "modules/demerzel",
    bin: "demerzel",
    needs: ["python3"],
    requires: [],
    platforms: { platform: "darwin", arch: "arm64" }, // macOS + Apple silicon only
  },
];

export const byId = Object.fromEntries(MODULES.map((m) => [m.id, m]));

/** External tools we can probe, and how a user installs each (macOS-first hint). */
// Hints are cross-platform on purpose — name the tool + where to get it, never
// assume a package manager (this ships to anyone, not one machine).
export const DEPS = {
  node:     { probe: "node --version",     hint: "Node 20+ — nodejs.org / nvm / your package manager" },
  tmux:     { probe: "tmux -V",            hint: "tmux — your package manager (brew · apt · dnf · pacman · pkg)" },
  sops:     { probe: "sops --version",     hint: "sops — github.com/getsops/sops/releases (or brew · apt)" },
  age:      { probe: "age --version",      hint: "age — github.com/FiloSottile/age/releases (or brew · apt)" },
  tailscale:{ probe: "tailscale version",  hint: "tailscale — tailscale.com/download" },
  python3:  { probe: "python3 --version",  hint: "Python 3.11+ — python.org / your package manager" },
};

/** Expand a selection to include hard requires (factory -> apiary, foundation). */
export function withRequires(ids) {
  const out = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...out]) {
      for (const req of byId[id]?.requires ?? []) {
        if (!out.has(req)) { out.add(req); changed = true; }
      }
    }
  }
  return MODULES.filter((m) => out.has(m.id)).map((m) => m.id);
}

export function platformOk(m) {
  if (!m.platforms) return true;
  const { platform, arch } = m.platforms;
  return (!platform || process.platform === platform) && (!arch || process.arch === arch);
}
