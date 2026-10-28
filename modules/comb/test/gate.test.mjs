/**
 * The gate's contract: block what would leak, and never become the leak.
 *
 * The rules are tested on plain data, without git. The last block runs a real
 * push through the installed hook, because a gate whose hook is never actually
 * invoked by git protects nothing, however good its rules are.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, unlinkSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { check, parseDeny, parseIgnore, machineRules, parseLog, SEP } from "../src/gate.mjs";
import { pushRange, readCommits, installRepo, installGlobal, status, MARK } from "../src/gate-git.mjs";

const SECRET = "cf-token-value-0123456789abcdefghij";
const commit = (files, who = "dev <dev@users.noreply.github.com>") =>
  [{ sha: "a".repeat(40), author: who, committer: who, files }];
const added = (path, ...lines) => ({ path, binary: false, added: lines.map((text, i) => ({ line: i + 1, text })) });
const rules = (f) => new Set(f.map((x) => x.rule));

describe("credentials", () => {
  test("a value from the store is caught verbatim, and never echoed", () => {
    const f = check(commit([added("deploy.sh", `export TOKEN=${SECRET}`)]), { known: { CF_API_TOKEN: SECRET } });
    assert.ok(rules(f).has("vault"));
    assert.ok(!JSON.stringify(f).includes(SECRET), "a finding must not contain the secret");
    assert.match(f[0].why, /CF_API_TOKEN/);
  });

  test("credential shapes from audit.mjs apply here too", () => {
    const f = check(commit([added("x.js", 'const k = "ghp_' + "a".repeat(36) + '"')]));
    assert.ok(rules(f).has("credential-shape"));
  });
});

describe("identity — the part a credential scanner misses", () => {
  const deny = parseDeny("Jane Doe\njane.doe@example.com\n/j(ane|\\.)\\s?doe/i\n# a comment");

  test("a name in a file", () => {
    assert.ok(rules(check(commit([added("package.json", '  "author": "Jane Doe"')]), { deny })).has("personal"));
  });

  test("an email as the commit author", () => {
    const f = check(commit([], "Jane <jane.doe@example.com>"), { deny });
    assert.deepEqual(f.map((x) => x.where), ["commit author", "commit committer"]);
  });

  test("a /regex/ entry catches other spellings", () => {
    assert.ok(rules(check(commit([added("README.md", "made by J. Doe")]), { deny })).has("personal"));
  });

  test("findings name the pattern by number, not by content", () => {
    const f = check(commit([added("a.txt", "Jane Doe")]), { deny });
    assert.ok(f.every((x) => !x.why.includes("Jane")));
  });

  test("comments and blank lines are not patterns", () => {
    assert.equal(deny.length, 3);
  });
});

describe("files that should never be committed", () => {
  for (const [path, rule] of [
    [".wrangler/cache/cf.json", "wrangler-state"],
    ["cf.json", "cf-json"],
    [".env", "dotenv"],
    ["app/.env.production", "dotenv"],
    [".dev.vars", "dev-vars"],
    ["certs/server.pem", "private-key-file"],
    ["lan_scan_results.json", "scan-dump"],
  ]) {
    test(`${path} → ${rule}`, () => assert.ok(rules(check(commit([added(path, "x")]))).has(rule)));
  }

  test(".env.example and a public key are fine", () => {
    assert.equal(check(commit([added(".env.example", "API_KEY="), added("id_ed25519.pub", "ssh-ed25519 AAAA")])).length, 0);
  });
});

describe("credentials written into code", () => {
  const C = (...lines) => rules(check(commit([added("src/main.cpp", ...lines)])));

  test("a hard-coded Wi-Fi SSID and password, as firmware writes them", () => {
    assert.ok(C('const char *HARDCODED_SSID = "HomeNet-5G";').has("hardcoded-credential"));
    assert.ok(C('const char *HARDCODED_PASSWORD = "s3cret-wifi-pw";').has("hardcoded-credential"));
    assert.ok(C('WiFi.begin("HomeNet", "s3cret-wifi-pw");').has("hardcoded-credential"));
    // Values that merely START like a placeholder word are real.
    assert.ok(C('const char *HARDCODED_SSID = "TestNet-5G";').has("hardcoded-credential"));
    assert.ok(C('wifi_password = "passw0rd123"').has("hardcoded-credential"));
  });

  test("a password in config or JSON", () => {
    assert.ok(C('"password": "hunter2hunter2"').has("hardcoded-credential"));
    assert.ok(C("db_passwd = 'Tr0ub4dor&3'").has("hardcoded-credential"));
  });

  test("placeholders and non-assignments pass", () => {
    for (const line of [
      'const char *HARDCODED_PASSWORD = "YOUR_WIFI_PASSWORD";',
      'const char *ssid = "your-ssid";',
      'password = "<password>"',
      'password: "${PASSWORD}"',
      'password = "********"',
      'ssid = "test"',
      'password = "example-password"',
      'const char *ap_ssid = "my_ssid";',
      '<input type="password" name="password">',
      'WiFi.begin(ssid, password);',
      'config.setPassword(password);',
    ]) assert.equal(C(line).size, 0, line);
  });
});

describe("home network and this machine", () => {
  test("a *.lan hostname and a real MAC are caught", () => {
    const f = check(commit([added("out.json", '{"host":"the-pi.lan","mac":"02:42:ac:11:00:02"}')]));
    assert.ok(rules(f).has("lan-hostname"));
    assert.ok(rules(f).has("mac-address"));
  });

  test("placeholder MACs from documentation are not", () => {
    assert.equal(check(commit([added("README.md", "lanscan --wol AA:BB:CC:DD:EE:FF")])).length, 0);
  });

  test("your own home path and hostname", () => {
    const machine = machineRules({ user: "jane.doe", hostname: "janes-Air.local" });
    const f = check(commit([added("log.txt", "/Users/jane.doe/work/x", "host janes-Air up")]), { machine });
    assert.ok(rules(f).has("home-path"));
    assert.ok(rules(f).has("machine-name"));
  });

  test("generic hostnames are not personal", () => {
    assert.equal(machineRules({ user: "u", hostname: "raspberrypi" }).length, 0);
  });
});

describe(".combgateignore", () => {
  test("silences a generic rule for a path", () => {
    const ignore = parseIgnore("oui.txt mac-address");
    assert.equal(check(commit([added("oui.txt", "00:1b:63:84:45:e6")]), { ignore }).length, 0);
  });

  test("**/ matches at the top level too", () => {
    const ignore = parseIgnore("**/index.html lan-hostname");
    assert.equal(check(commit([added("index.html", "pi.lan"), added("a/b/index.html", "pi.lan")]), { ignore }).length, 0);
  });

  test("cannot silence the personal list or the vault", () => {
    const ignore = parseIgnore("**");
    const f = check(commit([added("a.txt", `Jane Doe ${SECRET}`)]), { ignore, deny: parseDeny("Jane Doe"), known: { K: SECRET } });
    assert.deepEqual([...rules(f)].sort(), ["personal", "vault"]);
  });
});

describe("parsing git log -p", () => {
  test("added lines, their numbers, binary files; removals ignored", () => {
    const log = [
      `${SEP}${"b".repeat(40)}\x1fA\x1fa@x\x1fC\x1fc@x`,
      "diff --git a/f.txt b/f.txt", "--- a/f.txt", "+++ b/f.txt",
      "@@ -3,0 +4,2 @@", "+one", "+++two", "-gone",
      "diff --git a/img.png b/img.png", "Binary files /dev/null and b/img.png differ",
      "diff --git a/old.txt b/old.txt", "--- a/old.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    ].join("\n");
    const [c] = parseLog(log);
    assert.equal(c.author, "A <a@x>");
    assert.deepEqual(c.files[0].added, [{ line: 4, text: "one" }, { line: 5, text: "++two" }]);
    assert.deepEqual(c.files[1], { path: "img.png", binary: true, added: [] });
    assert.equal(c.files.length, 2, "a deleted file is not something being published");
  });
});

describe("a real push through the hook", () => {
  let dir, repo, remote, bin, env, saved;
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, env, encoding: "utf-8", ...opts });
  const commitFile = (path, body, msg) => {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), body);
    run("git", ["add", "-A"]); run("git", ["commit", "-qm", msg]);
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "comb-gate-"));
    repo = join(dir, "repo"); remote = join(dir, "remote.git"); bin = join(dir, "bin");
    mkdirSync(repo); mkdirSync(bin);
    // `comb` on PATH is this checkout, so the hook runs the code under test.
    symlinkSync(fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), join(bin, "comb"));
    env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, COMB_HOME: join(dir, "comb-home"),
      GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: "dev@users.noreply.github.com",
      GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: "dev@users.noreply.github.com",
    };
    // installRepo/status run git with this process's environment, not `env`. Isolate it too,
    // or a machine with the gate installed globally (core.hooksPath) makes installRepo find
    // that global hook, install nothing here, and every push below run unguarded.
    saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_NOSYSTEM = "1";
    spawnSync("git", ["init", "-q", "--bare", remote], { env });
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["remote", "add", "origin", remote]);
    installRepo(repo);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("the hook is reported as installed — in this repo, not somewhere global", () => {
    const st = status(repo);
    assert.equal(st.guarded, true);
    assert.ok(st.hook.startsWith(repo), `hook is at ${st.hook}`);
  });

  test("a clean push goes through", () => {
    commitFile("README.md", "# hello\n", "first");
    const r = run("git", ["push", "-q", "origin", "main"]);
    assert.equal(r.status, 0, r.stderr);
  });

  test("cf.json added then deleted is still blocked — it is in the history", () => {
    commitFile(".wrangler/cache/cf.json", '{"city":"Somewhere"}', "oops");
    run("git", ["rm", "-rq", ".wrangler"]); run("git", ["commit", "-qm", "remove it"]);
    const r = run("git", ["push", "origin", "main"]);
    assert.notEqual(r.status, 0, "the push must be refused");
    assert.match(r.stdout + r.stderr, /wrangler-state/);
    assert.equal(run("git", ["rev-parse", "origin/main"]).stdout, run("git", ["rev-parse", "HEAD~2"]).stdout, "the remote must not have moved");
  });

  test("pushRange: a deletion publishes nothing; a new branch publishes what the remote lacks", () => {
    assert.equal(pushRange(`(delete) ${"0".repeat(40)} refs/heads/x ${"1".repeat(40)}`), null);
    const tip = run("git", ["rev-parse", "HEAD"]).stdout.trim();
    const revs = pushRange(`refs/heads/main ${tip} refs/heads/main ${"0".repeat(40)}`, "origin");
    assert.ok(revs.includes("--remotes=origin"));
    assert.equal(readCommits(revs, repo).length, 2, "the two unpushed commits, not the one already on the remote");
  });

  test("pushRange: an ordinary push checks exactly what follows the remote's own tip", () => {
    const tip = run("git", ["rev-parse", "HEAD"]).stdout.trim();
    const base = run("git", ["rev-parse", "HEAD~1"]).stdout.trim();
    const revs = pushRange(`refs/heads/main ${tip} refs/heads/main ${base}`, "origin", () => true);
    assert.deepEqual(revs, [tip, "--not", base]);
  });

  test("pushRange: a force push over history this clone never had checks everything", () => {
    // What happened when a rewritten history was pushed from a clone of a local mirror: the
    // remote-tracking refs said it was all published already. The server's sha is the truth.
    const tip = run("git", ["rev-parse", "HEAD"]).stdout.trim();
    assert.deepEqual(pushRange(`refs/heads/main ${tip} refs/heads/main ${"f".repeat(40)}`, "origin", () => false), [tip]);
  });

  test("a bare repository (a mirror) is checked instead of erroring", async () => {
    const { readIgnoreFile } = await import("../src/gate-git.mjs");
    assert.equal(readIgnoreFile(remote), "", "no working tree, no ignore file, no error");
  });
});

describe("a global gate shares its hooks directory and worktrees with other tools", () => {
  // Entire (agent session capture) is the real case: it keeps its own pre-push in
  // .git/hooks, and when a global hooks path is set it installs itself there too,
  // in front of whatever pre-push it finds.
  let dir, repo, remote, bin, env, saved, hooks;
  const run = (cmd, args, cwd = repo) => spawnSync(cmd, args, { cwd, env, encoding: "utf-8" });
  const commitFile = (cwd, path, body, msg) => {
    writeFileSync(join(cwd, path), body);
    run("git", ["add", "-A"], cwd); run("git", ["commit", "-qm", msg], cwd);
  };
  // A stand-in for another tool's hook: records that it ran, and what stdin it got.
  const marker = (name) => `#!/bin/sh\ncat > "${dir}/${name}.ran"\n`;
  const ran = (name) => existsSync(join(dir, `${name}.ran`));
  const reset = () => { for (const n of ["own", "other"]) rmSync(join(dir, `${n}.ran`), { force: true }); };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "comb-gate-shared-"));
    repo = join(dir, "repo"); remote = join(dir, "remote.git"); bin = join(dir, "bin");
    hooks = join(dir, "comb-home", "hooks");
    mkdirSync(repo); mkdirSync(bin);
    symlinkSync(fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), join(bin, "comb"));
    env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, COMB_HOME: join(dir, "comb-home"),
      GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: "dev@users.noreply.github.com",
      GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: "dev@users.noreply.github.com",
    };
    // installGlobal writes the global git config and COMB_HOME of this process: isolate both.
    saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM, c: process.env.COMB_HOME };
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1", COMB_HOME: env.COMB_HOME });
    spawnSync("git", ["init", "-q", "--bare", remote], { env });
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["remote", "add", "origin", remote]);
    commitFile(repo, "README.md", "# weather\n", "first");
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s], ["COMB_HOME", saved.c]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("a pre-push already in the hooks directory is kept and still runs, after the gate", () => {
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-push"), marker("other")); chmodSync(join(hooks, "pre-push"), 0o755);
    const r = installGlobal();
    assert.equal(r.chained, join(hooks, "pre-push.comb-chained"));
    assert.ok(readFileSync(join(hooks, "pre-push"), "utf-8").includes(MARK));
    reset();
    const p = run("git", ["push", "-q", "origin", "main"]);
    assert.equal(p.status, 0, p.stderr);
    assert.ok(ran("other"), "the hook that was there before must still run");
    assert.match(readFileSync(join(dir, "other.ran"), "utf-8"), /refs\/heads\/main/, "and get the push's ref list on stdin");
  });

  test("installing again is an upgrade, not a second copy", () => {
    const r = installGlobal();
    assert.equal(r.chained, undefined);
    assert.equal(r.hook, join(hooks, "pre-push"));
  });

  test("the repository's own pre-push runs when pushing from a worktree", () => {
    // From a worktree, --git-dir is .git/worktrees/<name>: no hooks there. Entire's
    // pre-push (which uploads its checkpoints) was silently skipped from every lane.
    const own = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(own, marker("own")); chmodSync(own, 0o755);
    const wt = join(dir, "lane");
    run("git", ["worktree", "add", "-q", "-b", "lane/paris", wt]);
    commitFile(wt, "paris.txt", "cloudy\n", "paris");
    reset();
    const p = run("git", ["push", "-q", "origin", "lane/paris"], wt);
    assert.equal(p.status, 0, p.stderr);
    assert.ok(ran("own"), "the repository's own pre-push must run from a worktree");
  });

  test("a gate that blocks still blocks the hooks after it", () => {
    commitFile(repo, "cf.json", '{"city":"Somewhere"}', "oops");
    reset();
    const p = run("git", ["push", "origin", "main"]);
    assert.notEqual(p.status, 0, "the push must be refused");
    assert.ok(!ran("other") && !ran("own"), "nothing after a refusal runs");
    run("git", ["reset", "-q", "--hard", "HEAD~1"]);
  });

  test("a tool that already runs the gate under another name is updated there, not evicted", () => {
    // What Entire leaves: its pre-push in front, ours renamed to pre-push.pre-entire.
    rmSync(hooks, { recursive: true, force: true }); mkdirSync(hooks, { recursive: true });
    const theirs = `#!/bin/sh\n# Entire CLI hooks\n"$(dirname "$0")/pre-push.pre-entire" "$@"\n`;
    writeFileSync(join(hooks, "pre-push"), theirs);
    writeFileSync(join(hooks, "pre-push.pre-entire"), `#!/bin/sh\n${MARK} (an older copy)\n`);
    const r = installGlobal();
    assert.equal(r.hook, join(hooks, "pre-push.pre-entire"));
    assert.equal(r.via, join(hooks, "pre-push"));
    assert.equal(readFileSync(join(hooks, "pre-push"), "utf-8"), theirs, "their hook is left exactly as it was");
    assert.match(readFileSync(join(hooks, "pre-push.pre-entire"), "utf-8"), /--git-common-dir/, "our copy is the current one");
    assert.ok(!existsSync(join(hooks, "pre-push.comb-chained")));
  });
});
