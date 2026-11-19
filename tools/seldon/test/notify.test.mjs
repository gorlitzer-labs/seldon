import { test } from "node:test";
import assert from "node:assert/strict";
import { notifierArgs } from "../lib/notify.mjs";

test("notifierArgs: a click brings back the terminal seldon runs in", () => {
  const a = notifierArgs("seldon", 'say "hi"', { __CFBundleIdentifier: "com.googlecode.iterm2" });
  assert.equal(a[a.indexOf("-activate") + 1], "com.googlecode.iterm2");
  assert.equal(a[a.indexOf("-message") + 1], 'say "hi"');               // quotes pass through argv untouched
  assert.equal(notifierArgs("t", "m", {})[5], "com.apple.Terminal");     // no terminal known: Terminal.app
  assert.equal(notifierArgs("t", "m", { SELDON_NOTIFY_APP: "com.mitchellh.ghostty", __CFBundleIdentifier: "x" })[5], "com.mitchellh.ghostty");
});
