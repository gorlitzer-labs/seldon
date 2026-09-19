/**
 * Persistent user config — ~/.apiary/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".apiary");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface ApiaryConfig {
  sound?: boolean;
}

export function loadConfig(): ApiaryConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(config: ApiaryConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Pick a stable index into a pool based on a string seed.
 * Same seed always returns the same index. Different seeds tend to spread
 * across the pool, but collisions are possible with a finite pool.
 */
export function stableIndex(seed: string, poolSize: number): number {
  let hash = 0;
  for (const c of seed) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
  return ((hash % poolSize) + poolSize) % poolSize;
}

/** Stable per-agent insect/bug emoji pool. Used in tmux tab titles + wizard summary. */
export const BUG_POOL: readonly string[] = [
  "🐝", "🐛", "🦋", "🐞", "🪲", "🐜", "🦗", "🪳", "🦂", "🕷️",
  "🪰", "🦟", "🐌", "🐙", "🦑", "🦀", "🪱", "🦠", "🧬", "🔬",
];

/** Stable per-room hive emoji pool. Used in terminal tab titles for `serve` and `join`. */
export const HIVE_POOL: readonly string[] = ["🍯", "🐝", "🏠", "🪺", "🌸"];

/** Stable bug emoji for an agent — same name always gets the same bug. */
export function agentEmoji(agentName: string): string {
  return BUG_POOL[stableIndex(agentName, BUG_POOL.length)];
}

/** Stable hive emoji for a room — same room name always gets the same hive. */
export function roomEmoji(roomName: string): string {
  return HIVE_POOL[stableIndex(roomName, HIVE_POOL.length)];
}
