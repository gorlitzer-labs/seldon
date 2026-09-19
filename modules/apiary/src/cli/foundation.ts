/**
 * Foundation hook — best-effort bootstrap of the Foundation project workflow into a repo.
 *
 * apiary is the transport; Foundation (gorlitzer-labs/foundation) is the project substrate the hive
 * coordinates over. When a room is created, we install Foundation into each participant's repo so
 * the workflow "always follows". Entirely optional and non-fatal: if Foundation isn't reachable the
 * room still starts. apiary does not depend on Foundation at build time — this only shells out.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type FoundationResult = { ok: boolean; how: "local" | "npx" | "already" | "unavailable" | "no-dir" };

/** Install Foundation into `cwd`. Never throws. Idempotent (skips a repo already set up). */
export function foundationInit(cwd: string): FoundationResult {
  const dir = cwd.replace(/^~/, homedir());
  if (!existsSync(dir)) return { ok: false, how: "no-dir" };
  if (existsSync(join(dir, "docs", "QUEUE.md"))) return { ok: true, how: "already" };
  // Prefer a locally-installed `foundation`; otherwise npx the (private) GitHub repo.
  const attempts: Array<{ cmd: string; args: string[]; how: FoundationResult["how"] }> = [
    { cmd: "foundation", args: ["init", dir], how: "local" },
    { cmd: "npx", args: ["--yes", "github:gorlitzer-labs/foundation", "init", dir], how: "npx" },
  ];
  for (const a of attempts) {
    try {
      execFileSync(a.cmd, a.args, { stdio: "ignore", timeout: 90_000 });
      return { ok: true, how: a.how };
    } catch {
      /* try the next transport */
    }
  }
  return { ok: false, how: "unavailable" };
}
