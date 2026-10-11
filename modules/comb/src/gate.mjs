/**
 * The gate: nothing sensitive leaves this machine in a push.
 *
 * `comb audit` finds what already leaked. This stops the next one at the last
 * moment it can still be stopped for free. After a push to a public repo, a
 * leak is in other people's clones and caches, and it cannot be taken back.
 *
 * It exists because a credential scanner alone was tried, and it missed most of
 * what actually leaked. Across one account's public repos, gitleaks caught a
 * Telegram token and a private key. Things it has no rule for went straight
 * past it:
 *
 *   - a real name in package.json `author` fields, then published to npm
 *   - a work account's username, tying the person to an employer
 *   - `.wrangler/cache/cf.json`, Cloudflare's geolocation of the developer:
 *     town, ISP, postcode, coordinates
 *   - a committed scan of a home network: hostnames, MACs, SSH banners
 *   - a personal email as commit author on hundreds of commits
 *
 * So there are two kinds of rule, and the second is the one that matters:
 *
 *   - credentials   every value in the comb store, matched verbatim (certain),
 *                   plus the shapes from audit.mjs, plus gitleaks when installed
 *   - identity      a personal list (name, emails, hostnames) kept ENCRYPTED in
 *                   the store as COMB_GATE_DENY, never in a file — a denylist
 *                   committed to a repo would publish the very things it guards
 *
 * Every commit in the push is checked separately, not just the final tree. A
 * file added in one commit and deleted in the next is still in the history that
 * gets pushed. That is precisely how the cf.json above went public.
 *
 * Nothing here prints a matched value. A gate that echoes the secret it caught
 * has written it to a terminal, and possibly to an agent's transcript.
 *
 * This module is pure: rules in, commits in, findings out. No git, no disk, so
 * every rule can be tested without a repository. `gate-git.mjs` does the I/O.
 */
import { SHAPES } from "./audit.mjs";

/** The store entry holding the personal list. One pattern per line. */
export const DENY_KEY = "COMB_GATE_DENY";

/**
 * Paths that should never be committed, whatever is in them.
 *
 * Checked on files added or modified, never deleted: deleting a `.env` is
 * the fix, not the offence.
 */
export const PATH_RULES = [
  { id: "wrangler-state", why: "wrangler's local state (cf.json holds your geolocation)", rx: /(^|\/)\.wrangler\// },
  { id: "cf-json", why: "Cloudflare request metadata: your town, ISP and coordinates", rx: /(^|\/)cf\.json$/ },
  { id: "dotenv", why: "an environment file", rx: /(^|\/)\.env(\.[^/]*)?$/, unless: /\.(example|sample|template|dist)$/ },
  { id: "dev-vars", why: "wrangler's local secrets file", rx: /(^|\/)\.dev\.vars$/ },
  { id: "private-key-file", why: "a private key", rx: /(^|\/)(id_(rsa|ed25519|ecdsa|dsa)|[^/]*\.(pem|p12|pfx|key))$/, unless: /\.pub$/ },
  { id: "kubeconfig", why: "cluster credentials", rx: /(^|\/)(kubeconfig|\.kube\/config)$/ },
  { id: "scan-dump", why: "a network scan result (hostnames, MACs, open ports)", rx: /(^|\/)[^/]*scan[_-]?results?[^/]*\.(json|txt|csv|xml)$/i },
];

/**
 * Content that is about a home network rather than about code.
 *
 * MAC addresses have a short allowlist of the placeholders documentation uses;
 * anything else in a diff is almost always a real device someone scanned.
 */
const FAKE_MACS = /^(00:00:00:00:00:00|ff:ff:ff:ff:ff:ff|aa:bb:cc:dd:ee:ff|00:11:22:33:44:55|01:23:45:67:89:ab|de:ad:be:ef:[0-9a-f:]+|12:34:56:78:9a:bc)$/i;
/**
 * A credential written into code as a literal: a Wi-Fi SSID and password in firmware, a
 * password in a config or a test. No scanner recognises these by shape (a Wi-Fi password
 * is any 8+ characters), which is how two home networks' credentials sat in a repo's
 * history unflagged. So this keys on the NAME being assigned, and lets placeholders
 * through: YOUR_WIFI_PASSWORD, <ssid>, ${PASS}, ****, changeme and the like.
 */
const PLACEHOLDER = /^(your|my[_-]?|<|\$|\{|%|x{3,}|\*{3,}|\.{3}|change[_-]?me|example|placeholder|dummy|fake|sample|test|todo|tbd|null|none|undefined|redacted|password|passwd|secret|ssid|pass)/i;
const literalValue = (m) => (m.match(/["']([^"']*)["']\s*\)?\s*$/) ?? [])[1] ?? "";
export const CONTENT_RULES = [
  {
    id: "hardcoded-credential", why: "a password or Wi-Fi credential written into the code",
    rx: /\b[\w.-]*(?:ssid|passw(?:or)?d|pwd|psk|wifi[_-]?pass|ap[_-]?pass)[\w.-]*["']?\s*[:=]\s*["'][^"'\s]{4,}["']/gi,
    skip: (m) => PLACEHOLDER.test(literalValue(m)) || /YOUR/i.test(literalValue(m)),
  },
  {
    id: "hardcoded-credential", why: "Wi-Fi credentials passed as literals",
    rx: /WiFi\.begin\(\s*"[^"]+"\s*,\s*"[^"]{4,}"\s*\)/g,
    skip: (m) => PLACEHOLDER.test(literalValue(m)) || /YOUR/i.test(m),
  },
  { id: "lan-hostname", why: "a hostname on a home network (*.lan)", rx: /\b[a-z0-9][a-z0-9-]*\.lan\b/gi },
  { id: "mac-address", why: "a hardware (MAC) address", rx: /\b(?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2}\b/gi, skip: (m) => FAKE_MACS.test(m) },
];

/**
 * Parse the personal list: one pattern per line.
 *
 * A plain line matches as a case-insensitive substring. `/…/flags` is a regex,
 * for the cases a substring cannot express (a name spelled several ways).
 * Blank lines and `#` comments are allowed, so the list can carry notes.
 */
export function parseDeny(text = "") {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((p, i) => {
    const m = p.match(/^\/(.+)\/([a-z]*)$/);
    const rx = m ? new RegExp(m[1], m[2].includes("g") ? m[2] : m[2] + "g") : new RegExp(escape(p), "gi");
    return { n: i + 1, rx };
  });
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What this machine says about the person using it.
 *
 * The home path names the login (`/Users/jane.doe`), and the hostname
 * is often the owner's name (`alices-macbook`). Both end up in logs, configs and
 * scan output that get committed without anyone reading them. Derived at run
 * time, so they never need to be written down anywhere.
 */
export function machineRules({ user, hostname } = {}) {
  const rules = [];
  if (user && user.length >= 3) {
    rules.push({ id: "home-path", why: "your home directory path", rx: new RegExp(`/(Users|home)/${escape(user)}(?=/|\\b)`, "g") });
  }
  const host = (hostname ?? "").replace(/\.(local|lan|home)$/i, "");
  // Generic hostnames ("localhost", "mac", "raspberrypi") say nothing about anyone.
  if (host.length >= 6 && !/^(localhost|raspberrypi|ubuntu|debian|macbook(-pro|-air)?)$/i.test(host)) {
    rules.push({ id: "machine-name", why: "this machine's hostname", rx: new RegExp(`\\b${escape(host)}\\b`, "gi") });
  }
  return rules;
}

/**
 * A `.combgateignore` in the repo: lines of `<path glob> [rule-id,rule-id]`.
 *
 * Only the generic rules can be ignored. Credentials and the personal list
 * cannot: a file inside the repo saying "my name may appear here" is itself a
 * place the name appears, and a secret is never a false positive worth keeping.
 */
export function parseIgnore(text = "") {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const [glob, ids] = l.split(/\s+/);
    return { path: globToRx(glob), ids: ids ? new Set(ids.split(",")) : null };
  });
}

function globToRx(glob) {
  // `**/` is zero or more directories, so `**/index.html` also matches a
  // top-level index.html, as it does in .gitignore.
  const rx = glob.split("**/").map((seg) =>
    seg.split("**").map((part) => part.split("*").map(escape).join("[^/]*")).join(".*")).join("(?:.*/)?");
  return new RegExp(`^${rx}$`);
}

/**
 * The generic rules, which can be wrong about a repo: a test fixture holding a
 * fake private-key header, a public analytics token gitleaks takes for a key,
 * a machine name used on purpose as an example. Never `vault` or `personal`.
 */
const IGNORABLE = new Set([...PATH_RULES, ...CONTENT_RULES].map((r) => r.id)
  .concat(["home-path", "machine-name", "credential-shape", "gitleaks"]));

export function isIgnored(ignore, path, id) { return ignored(ignore, path, id); }

function ignored(ignore, path, id) {
  if (!IGNORABLE.has(id)) return false;
  return ignore.some((r) => r.path.test(path) && (!r.ids || r.ids.has(id)));
}

/**
 * Check commits. Returns findings; never the matched text.
 *
 * `commits`: [{ sha, author, committer, files: [{ path, binary, added: [{ line, text }] }] }]
 * `known`:   name → value, from the comb store
 * `deny`:    parsed personal list
 */
export function check(commits, { known = {}, deny = [], machine = [], ignore = [], minSecret = 12 } = {}) {
  const findings = [];
  const secrets = Object.entries(known).filter(([n, v]) => n !== DENY_KEY && typeof v === "string" && v.length >= minSecret);
  const add = (f) => findings.push(f);

  const contentRules = [
    ...SHAPES.map((s) => ({ id: "credential-shape", why: s.name, rx: s.rx })),
    ...CONTENT_RULES,
    ...machine,
  ];

  for (const c of commits) {
    // Who the commit says made it. A personal email here is published with the
    // commit just as surely as one in a file.
    for (const [role, who] of [["author", c.author], ["committer", c.committer]]) {
      if (!who) continue;
      for (const d of deny) if (test(d.rx, who)) add({ sha: c.sha, where: `commit ${role}`, rule: "personal", why: `personal pattern #${d.n}` });
      for (const [name, v] of secrets) if (who.includes(v)) add({ sha: c.sha, where: `commit ${role}`, rule: "vault", why: `the value of ${name}` });
    }

    for (const f of c.files ?? []) {
      for (const r of PATH_RULES) {
        if (r.rx.test(f.path) && !(r.unless && r.unless.test(f.path)) && !ignored(ignore, f.path, r.id)) {
          add({ sha: c.sha, where: f.path, rule: r.id, why: r.why });
        }
      }
      for (const d of deny) if (test(d.rx, f.path)) add({ sha: c.sha, where: f.path, rule: "personal", why: `personal pattern #${d.n} in the file name` });
      if (f.binary) continue;

      for (const { line, text } of f.added ?? []) {
        const at = `${f.path}:${line}`;
        for (const [name, v] of secrets) if (text.includes(v)) add({ sha: c.sha, where: at, rule: "vault", why: `the value of ${name}` });
        for (const d of deny) if (test(d.rx, text)) add({ sha: c.sha, where: at, rule: "personal", why: `personal pattern #${d.n}` });
        for (const r of contentRules) {
          if (ignored(ignore, f.path, r.id)) continue;
          r.rx.lastIndex = 0;
          const hits = text.match(r.rx) ?? [];
          if (hits.some((h) => !r.skip?.(h))) add({ sha: c.sha, where: at, rule: r.id, why: r.why });
        }
      }
    }
  }
  return findings;
}

function test(rx, s) {
  rx.lastIndex = 0;
  return rx.test(s);
}

/**
 * Parse `git log -p` output (with the format from gate-git.mjs) into commits.
 *
 * Only added lines are kept, with their line numbers in the new file. Removed
 * lines are what the commit took out of the repo, which is never a leak.
 */
export const SEP = "\x1ecomb-gate\x1f";
export function parseLog(out) {
  const commits = [];
  let c = null, f = null, line = 0, prev = "";
  for (const raw of out.split("\n")) {
    const after = prev; prev = raw;
    if (raw.startsWith(SEP)) {
      const [sha, an, ae, cn, ce] = raw.slice(SEP.length).split("\x1f");
      c = { sha, author: `${an} <${ae}>`, committer: `${cn} <${ce}>`, files: [] };
      commits.push(c); f = null; continue;
    }
    if (!c) continue;
    if (raw.startsWith("diff --git ")) { f = null; continue; }
    // A file header is `+++ ` straight after `--- `. Checking the pair matters
    // with -U0: an added line that itself starts with "++" reads as `+++ …` too.
    if (raw.startsWith("+++ ") && after.startsWith("--- ")) {
      const p = raw.slice(4);
      f = p === "/dev/null" ? null : { path: p.replace(/^b\//, ""), added: [], binary: false };
      if (f) c.files.push(f);
      continue;
    }
    const bin = raw.match(/^Binary files (?:a\/.+|\/dev\/null) and b\/(.+) differ$/);
    if (bin) { c.files.push({ path: bin[1], binary: true, added: [] }); f = null; continue; }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (f && raw.startsWith("+")) { f.added.push({ line, text: raw.slice(1) }); line++; }
  }
  return commits;
}
