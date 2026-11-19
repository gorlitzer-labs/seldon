import { test } from "node:test";
import assert from "node:assert/strict";
import { claudePoller } from "../lib/agents.mjs";

test("claudePoller: after the first read, answers at once from the last background read", () => {
  const calls = [];
  const run = (_bin, _args, _opts, cb) => { calls.push(cb); };      // a read that has not finished
  const now = claudePoller(run);
  now();                                                            // first call: a real read
  calls.shift()(null, JSON.stringify([{ id: "a" }]));
  assert.deepEqual(now(), [{ id: "a" }]);                           // no waiting on a new read
  assert.equal(calls.length, 1, "one background read in flight");
  now(); now();
  assert.equal(calls.length, 1, "never two at once");
  calls.shift()(new Error("timed out"), "");
  assert.deepEqual(now(), [{ id: "a" }], "a failed read keeps the last good answer");
  calls.shift()(null, JSON.stringify([{ id: "b" }]));
  assert.deepEqual(now(), [{ id: "b" }]);
});
