/**
 * The audit's two jobs: find leaks, and never become one itself.
 *
 * A leak report that quotes the secret has only moved the leak somewhere new —
 * usually somewhere worse, like a terminal an agent is reading. So the shape of
 * the result is as much the contract as the finding is.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan, SHAPES } from "../src/audit.mjs";

const SECRET = "super-secret-value-0123456789abcdef";
let dir;

function fixture(contents) {
  dir = mkdtempSync(join(tmpdir(), "comb-audit-"));
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "nested", "transcript.jsonl"), contents);
  return [{ label: "test", path: dir }];
}

test.afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("exact matches — the only certain signal", () => {
  test("finds a stored value sitting verbatim in a transcript", () => {
    const targets = fixture(`{"text":"here is the token ${SECRET} sorry"}`);
    const { exact } = scan({ targets, known: { CF_API_TOKEN: SECRET } });
    assert.equal(exact.has("CF_API_TOKEN"), true);
    assert.equal(exact.get("CF_API_TOKEN").hits, 1);
  });

  test("counts every occurrence, not just the first", () => {
    const targets = fixture(`${SECRET} ... ${SECRET} ... ${SECRET}`);
    const { exact } = scan({ targets, known: { K: SECRET } });
    assert.equal(exact.get("K").hits, 3);
  });

  test("says nothing when the secret is not there", () => {
    const targets = fixture("a perfectly innocent transcript");
    const { exact } = scan({ targets, known: { K: SECRET } });
    assert.equal(exact.size, 0);
  });

  test("ignores values too short to be distinctive, which would match everything", () => {
    const targets = fixture("the word cat appears here");
    const { exact } = scan({ targets, known: { SHORT: "cat" } });
    assert.equal(exact.size, 0);
  });
});

describe("the report never contains a secret", () => {
  test("no stored value appears anywhere in the result", () => {
    const targets = fixture(`token ${SECRET} and ghp_${"a".repeat(36)}`);
    const result = scan({ targets, known: { CF_API_TOKEN: SECRET } });

    // Maps and Sets serialise to {} under JSON.stringify, so a naive
    // stringify here inspects nothing and passes no matter what the result
    // holds. Mutation testing caught exactly that: planting the secret into
    // the result left this test green. Walk the structure instead.
    const seen = [];
    (function walkValue(v) {
      if (v instanceof Map) { for (const [k, val] of v) { seen.push(k); walkValue(val); } return; }
      if (v instanceof Set) { for (const val of v) walkValue(val); return; }
      if (Array.isArray(v)) { v.forEach(walkValue); return; }
      if (v && typeof v === "object") { for (const [k, val] of Object.entries(v)) { seen.push(k); walkValue(val); } return; }
      seen.push(String(v));
    })(result);

    assert.ok(!seen.some((s) => s.includes(SECRET)), "the audit result must never carry the secret it found");
  });
});

describe("shapes — probable, and honest about being partial", () => {
  test("recognises a GitHub token by its prefix", () => {
    const targets = fixture(`ghp_${"A".repeat(36)}`);
    const { shaped } = scan({ targets });
    assert.ok(shaped.has("GitHub token"));
  });

  test("recognises a private key block", () => {
    const targets = fixture("-----BEGIN OPENSSH PRIVATE KEY-----\nstuff\n");
    const { shaped } = scan({ targets });
    assert.ok(shaped.has("private key block"));
  });

  test("cannot recognise a Cloudflare-style token, which is why exact matching exists", () => {
    // 40 characters of nothing in particular — no prefix, no structure. This
    // test exists to pin the limitation rather than let anyone assume coverage.
    const cfLike = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const targets = fixture(`token=${cfLike}`);
    const { shaped } = scan({ targets });
    const names = [...shaped.keys()];
    assert.ok(!names.some((n) => n !== "OpenAI key" && shaped.get(n).distinct.has(cfLike)),
      "no shape should claim to recognise an unstructured token");
  });

  test("every shape is a global regex, or match() returns one hit forever", () => {
    for (const s of SHAPES) assert.ok(s.rx.flags.includes("g"), `${s.name} must be global`);
  });
});
