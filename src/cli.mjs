#!/usr/bin/env node
/**
 * comb — keep your keys out of your conversations.
 *
 * The problem this exists for: you paste a Cloudflare token to an agent so it
 * can do a job, and that token is now in a transcript file forever. Do it enough
 * times and you have no idea which credentials are exposed or which to rotate.
 *
 * So: secrets are referred to by NAME, never by value. `comb run` hands the
 * value to a child process's environment and nowhere else — not to a shell, not
 * to history, not into the conversation. `comb audit` tells you which ones
 * escaped anyway, because some already have.
 *
 * Rotation stays manual on purpose. Rotating a credential automatically needs a
 * credential that can rotate credentials — a CF token with Edit-API-Tokens, a
 * GitHub PAT with admin scope. That meta-credential is strictly more dangerous
 * than the ones it replaces, lives in the same store, and nothing can rotate it.
 * `comb rotate` therefore does the part a tool should: tells you where to go,
 * takes the new value without echoing it, and records when it changed.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import * as store from "./backends/sops.mjs";
import { scan, defaultTargets } from "./audit.mjs";

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const say = (s) => process.stdout.write(s + "\n");

/**
 * Read a secret from the terminal without echoing it.
 *
 * Not an argument, deliberately. A value on the command line is in your shell
 * history, in `ps` output while it runs, and in this conversation if an agent
 * typed the command — which is the exact leak comb exists to stop.
 */
async function promptSecret(label) {
  if (!process.stdin.isTTY) {
    // Piped input is fine and is how scripts and agents should feed a value.
    return (await new Promise((r) => {
      let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => r(d));
    })).trim();
  }
  process.stdout.write(`${label}: `);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Silence the echo: the value should not be on screen, over a shoulder or in
  // a screen recording.
  const onData = () => process.stdout.write("\x1b[2K\r" + label + ": ");
  process.stdin.on("data", onData);
  const value = await new Promise((r) => rl.question("", r));
  process.stdin.off("data", onData);
  rl.close();
  process.stdout.write("\n");
  return value.trim();
}

function help() {
  say([
    `${B("comb")} — keep your keys out of your conversations`,
    "",
    `  ${B("comb init")}                       create the age key and the encrypted store`,
    `  ${B("comb set")} <NAME> [--url <where>] take a value without echoing it, and store it`,
    `  ${B("comb ls")}                         names, age and notes — never values`,
    `  ${B("comb run")} --with A,B -- <cmd>    run a command with those secrets in its env`,
    `  ${B("comb rotate")} <NAME>              where to go, then take the new value`,
    `  ${B("comb audit")}                      which secrets leaked into transcripts and history`,
    `  ${B("comb rm")} <NAME>                  forget one`,
    "",
    dim("  Values are never printed, never passed as arguments, never logged."),
    dim("  `comb get NAME --reveal` exists for when you genuinely need to read one."),
  ].join("\n"));
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--") { flags["--"] = rest.slice(i + 1); break; }
  if (a.startsWith("--")) {
    const k = a.slice(2), n = rest[i + 1];
    if (n === undefined || n.startsWith("--")) flags[k] = true; else { flags[k] = n; i++; }
  } else pos.push(a);
}

try {
  switch (cmd) {
    case "init": {
      const { home, recipient } = store.init();
      say(`${green("✓")} store ready at ${B(home)}`);
      say(dim(`  public key  ${recipient}`));
      say(dim(`  private key ${home}/age.key — back this up somewhere safe; nothing else can recover the store`));
      break;
    }

    case "set": case "add": {
      const name = pos[0];
      if (!name) throw new Error("which one? `comb set CF_API_TOKEN`");
      const value = await promptSecret(`value for ${name}`);
      if (!value) throw new Error("nothing entered — not stored");
      store.writeSecret(name, value, typeof flags.url === "string" ? { url: flags.url } : {});
      say(`${green("✓")} ${name} stored ${dim(`(${value.length} characters — not shown, not logged)`)}`);
      break;
    }

    case "rotate": {
      const name = pos[0];
      if (!name) throw new Error("which one? `comb rotate CF_API_TOKEN`");
      const all = store.readAll();
      const cur = all[name];
      if (!cur) throw new Error(`no secret called ${name} — see \`comb ls\``);
      say(`${B(name)} last changed ${cur.updated ? cur.updated.slice(0, 10) : "unknown"}`);
      if (cur.url) say(`rotate it here: ${B(cur.url)}`);
      say(dim("revoke the old one at the provider AFTER the new one is verified working"));
      const value = await promptSecret(`new value for ${name}`);
      if (!value) throw new Error("nothing entered — the old value is untouched");
      store.writeSecret(name, value, cur.url ? { url: cur.url } : {});
      say(`${green("✓")} ${name} updated. Old value is gone from the store.`);
      break;
    }

    case "ls": {
      const all = store.readAll();
      const names = Object.keys(all).sort();
      if (names.length === 0) { say(dim("  nothing stored yet — `comb set NAME`")); break; }
      say(B("  name                          updated      note"));
      for (const n of names) {
        const e = all[n] ?? {};
        say(`  ${n.padEnd(29)} ${(e.updated ?? "").slice(0, 10).padEnd(12)} ${e.url ?? ""}`);
      }
      break;
    }

    case "get": {
      const name = pos[0];
      if (!name) throw new Error("which one?");
      if (flags.reveal !== true) throw new Error("that prints a secret to your terminal — pass --reveal if you mean it");
      const all = store.readAll();
      if (!(name in all)) throw new Error(`no secret called ${name}`);
      process.stdout.write(all[name].value + "\n");
      break;
    }

    case "run": {
      const want = typeof flags.with === "string" ? flags.with.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const command = flags["--"] ?? [];
      if (command.length === 0) throw new Error("what should I run? `comb run --with CF_API_TOKEN -- curl ...`");
      const all = store.readAll();
      const env = { ...process.env };
      for (const n of want) {
        if (!(n in all)) throw new Error(`no secret called ${n} — see \`comb ls\``);
        env[n] = all[n].value;
      }
      const r = spawnSync(command[0], command.slice(1), { stdio: "inherit", env });
      process.exit(r.status ?? 1);
    }

    case "rm": {
      const name = pos[0];
      if (!name) throw new Error("which one?");
      store.deleteSecret(name);
      say(`${green("✓")} ${name} removed from the store ${dim("(this does NOT revoke it at the provider)")}`);
      break;
    }

    case "audit": {
      const known = store.initialised()
        ? Object.fromEntries(Object.entries(store.readAll()).map(([k, v]) => [k, v?.value]))
        : {};
      const targets = defaultTargets();
      say(`${B("comb audit")} ${dim(`scanning ${targets.length} place(s) credentials go to be forgotten`)}`);
      for (const t of targets) say(dim(`  · ${t.label}`));
      say("");

      const { exact, shaped } = scan({ targets, known });

      if (exact.size === 0) say(green("  no stored secret was found verbatim in any of them"));
      for (const [name, rec] of exact) {
        say(red(`  LEAKED  ${name}`) + dim(` — ${rec.hits} occurrence(s) across ${rec.files.size} file(s): ${[...rec.labels].join(", ")}`));
      }
      say("");
      if (shaped.size === 0) {
        say(dim("  nothing credential-shaped found either"));
      } else {
        say(B("  credential-shaped strings (not necessarily yours):"));
        for (const [name, rec] of shaped) {
          say(yellow(`  ${name}`) + dim(` — ${rec.distinct.size} distinct, ${rec.hits} occurrence(s), ${rec.files.size} file(s): ${[...rec.labels].join(", ")}`));
        }
      }
      say("");
      say(dim("  A Cloudflare token is 40 characters of nothing in particular and cannot be"));
      say(dim("  matched by shape. Finding none above does not mean none are there."));
      break;
    }

    case undefined: case "help": case "--help": case "-h": help(); break;
    case "version": case "--version": case "-v": say("comb 0.1.0"); break;
    default: say(red(`unknown command: ${cmd}`)); help(); process.exit(2);
  }
} catch (e) {
  say(red(`✗ ${e.message}`));
  process.exit(1);
}
