// ADR-reversal tripwire — catch a decision that was silently reversed.
// For each ADR whose Status is Accepted, take the REJECTED alternatives and check whether the repo
// now actually contains one of them (in package.json deps). A hit = the repo did what an Accepted
// ADR said it rejected. Heuristic (alias table + token grep) — reports as PLAUSIBLE, not certain.
import { join } from "node:path";
import { read } from "./lib/fs.mjs";

// rejected-term → real dependency/dir tokens it would show up as
const ALIASES = {
  "react native": ["react-native", "expo"], "expo": ["expo"],
  "express": ["express"], "fastify": ["fastify"], "koa": ["koa"], "hono": ["hono"],
  "mongodb": ["mongodb", "mongoose"], "mysql": ["mysql", "mysql2"], "postgres": ["pg", "postgres", "drizzle-orm"],
  "prisma": ["prisma", "@prisma/client"], "drizzle": ["drizzle-orm"], "sequelize": ["sequelize"],
  "redux": ["redux", "@reduxjs/toolkit"], "mobx": ["mobx"], "zustand": ["zustand"],
  "webpack": ["webpack"], "vite": ["vite"], "rollup": ["rollup"],
  "jest": ["jest"], "vitest": ["vitest"], "mocha": ["mocha"],
  "password": ["bcrypt", "argon2", "bcryptjs"], "jwt": ["jsonwebtoken", "jose"],
};

function depTokens(root) {
  const p = read(join(root, "package.json"));
  if (!p) return new Set();
  try { const j = JSON.parse(p); return new Set(Object.keys({ ...j.dependencies, ...j.devDependencies })); }
  catch { return new Set(); }
}

// Parse ADRs: `## ADR-0001: Title` ... `**Status:** Accepted` ... `**Alternatives considered:** ...`
export function scanReversals(root) {
  const text = read(join(root, "docs", "DECISIONS.md"));
  if (!text) return [];
  const deps = depTokens(root);
  const blocks = text.split(/\n(?=## ADR-)/);
  const hits = [];
  for (const b of blocks) {
    const title = (b.match(/## (ADR-\d{4}: .+)/) || [])[1];
    if (!title) continue;
    if (!/\*\*Status:\*\*\s*Accepted/i.test(b)) continue;
    const alt = (b.match(/\*\*Alternatives considered:\*\*\s*(.+)/i) || [])[1] || "";
    const altLc = alt.toLowerCase();
    for (const [term, tokens] of Object.entries(ALIASES)) {
      if (!altLc.includes(term)) continue;
      const present = tokens.filter((t) => deps.has(t));
      if (present.length) hits.push({ adr: title, rejected: term, foundInDeps: present });
    }
  }
  return hits;
}
