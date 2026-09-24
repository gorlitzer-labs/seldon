import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPublishError } from "../scripts/publish-lib.mjs";

test("a staged-version 409 is recognised as already on its way", () => {
  const real = 'npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/@gorlitzer-labs%2ffactory - Cannot publish over previously staged version "0.1.3".';
  assert.equal(classifyPublishError(real), "staged");
});
test("every other failure stays a failure", () => {
  assert.equal(classifyPublishError("npm error code E403\nnpm error 403 Forbidden - You cannot publish over the previously published versions: 0.1.2."), "error");
  assert.equal(classifyPublishError("npm error code E409\nnpm error 409 Conflict - some other conflict"), "error");
  assert.equal(classifyPublishError("npm error code ENEEDAUTH"), "error");
  assert.equal(classifyPublishError(""), "error");
});
