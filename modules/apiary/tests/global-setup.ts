/**
 * Every test run gets a throwaway HOME.
 *
 * apiary keeps its state under `homedir()/.apiary` (rooms, sessions, invites,
 * rules), and the integration suite spawns real `apiary serve` processes. With
 * the developer's HOME inherited, each run left ~90 auto-named room files in
 * the real ~/.apiary/rooms — thousands over a few months, all showing up in
 * `apiary room list`. Set here, before any worker starts, so both in-process
 * module constants and every spawned CLI see the sandbox.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), "apiary-test-home-"));
  process.env.APIARY_TEST_REAL_HOME = process.env.HOME ?? "";
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => rmSync(home, { recursive: true, force: true });
}
