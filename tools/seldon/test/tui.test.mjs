import { test } from "node:test";
import assert from "node:assert/strict";
import { box, rule, hintRule, width, stripAnsi, toastLines, placeToast, placeModal, fresh } from "../lib/tui.mjs";

test("width: ANSI is invisible, emoji take two columns", () => {
  assert.equal(width("\x1b[32mok\x1b[0m"), 2);
  assert.equal(width("🦊 joey"), 7);
});

test("straight lines only: no corners or vertical bars anywhere (some iTerm fonts lack them)", () => {
  const drawn = [...box(["Stop joey?", "y yes · n no"], { title: "confirm" }), ...toastLines("started joey", "ok"),
    rule(40, { left: "seldon", right: "⚑ 1" }), hintRule(["⏎ open", "q quit"], 40)].join("\n");
  assert.doesNotMatch(drawn, /[╭╮╰╯│┌┐└┘|]/);
});

test("rule: title left, extra right, exactly the width asked", () => {
  const r = rule(40, { left: "seldon", right: "⚑ 1  ● 3" });
  assert.equal(width(r), 40);
  assert.match(r, /^── seldon ─+ ⚑ 1  ● 3 ──$/);
  assert.match(hintRule(["⏎ open", "q quit"], 30), /^── ⏎ open · q quit ─+$/);
});

test("box: every line the same width, title in the top rule", () => {
  const b = box(["Stop joey?", "y yes · n no"], { title: "confirm" });
  assert.equal(new Set(b.map(width)).size, 1);
  assert.match(b[0], /^── confirm ─+$/);
});

test("placeToast: right-aligned on the filler rows above the hints, the list untouched", () => {
  const screen = ["SELDON", "joey", "", "", "", "── hints"];
  const out = placeToast(screen, toastLines("started joey", "ok"), 30, 1);
  assert.deepEqual(out.slice(0, 2), ["SELDON", "joey"]);
  assert.equal(out[5], "── hints");
  assert.match(stripAnsi(out[4]), /── ✓ started joey ──$/);
  assert.equal(width(out[4]), 28);
});

test("placeModal: dims the screen and centres the box", () => {
  const screen = Array.from({ length: 9 }, (_, i) => `line ${i}`);
  const b = box(["Stop joey?"]);
  const out = placeModal(screen, b, 30, 9, (x) => `<${x}>`);
  assert.equal(out[0], "<line 0>");
  assert.ok(stripAnsi(out[4]).includes("  Stop joey?"));
  assert.ok(stripAnsi(out[3]).includes("────"));
});

test("fresh: a toast shows for four seconds", () => {
  assert.equal(fresh({ at: 1000 }, 4000), true);
  assert.equal(fresh({ at: 1000 }, 5001), false);
  assert.equal(fresh(null), false);
});
