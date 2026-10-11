// Multi-harness skill mirroring — one SKILL.md source → Claude Code + Cursor + Copilot + Codex.
// Foundation-owned (no vendored dep). Apiary-style multi-harness reach; apiary itself not required.

// Parse a minimal `--- yaml ---` frontmatter block. Returns { meta, body }.
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2].trimStart() };
}

// Each target: where the file goes + how to render it from (meta, body).
// Claude Code consumes SKILL.md directly, so it's installed verbatim (not "mirrored").
export const TARGETS = {
  cursor: {
    rel: (name) => `.cursor/commands/${name}.md`,
    render: (meta, body) => `# /${meta.name}\n\n${meta.description || ""}\n\n${body}`,
  },
  copilot: {
    rel: (name) => `.vscode/prompts/${name}.prompt.md`,
    render: (meta, body) => `---\nmode: agent\ndescription: ${meta.description || ""}\n---\n\n${body}`,
  },
  codex: {
    rel: (name) => `.codex/prompts/${name}.md`,
    render: (meta, body) => `# ${meta.name}\n\n> ${meta.description || ""}\n\n${body}`,
  },
};

// Given a skill's raw SKILL.md, produce [{ rel, content }] for every non-Claude harness.
export function mirrorSkill(name, raw) {
  const { meta, body } = parseFrontmatter(raw);
  meta.name = meta.name || name;
  return Object.values(TARGETS).map((t) => ({ rel: t.rel(name), content: t.render(meta, body) }));
}
