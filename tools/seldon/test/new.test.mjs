import { test } from "node:test";
import assert from "node:assert/strict";
import { newProjectPlan } from "../lib/projects.mjs";
import { STEWARD_ALLOWED } from "../lib/steward.mjs";

test("seldon new: only a plain name, only a folder that does not exist yet", () => {
  const none = () => false, all = () => true;
  assert.deepEqual(newProjectPlan("tide-tables", "/h/Desktop", none), { dir: "/h/Desktop/tide-tables" });
  for (const bad of ["", "../etc", "a/b", ".hidden", "-rf", "x y"]) assert.ok(newProjectPlan(bad, "/h/Desktop", none).why, `refuses "${bad}"`);
  assert.match(newProjectPlan("stranded", "/h/Desktop", all).why, /already exists/);
});

test("the steward may create projects, and nothing broader than that", () => {
  assert.ok(STEWARD_ALLOWED.includes("Bash(seldon new:*)"));
  assert.ok(!STEWARD_ALLOWED.some((t) => /mkdir|git |rm /.test(t)));
});
