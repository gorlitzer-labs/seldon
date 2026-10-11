/** Guard: the suite must never run against the developer's real HOME. */
import { describe, test, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";

describe("test sandbox", () => {
  test("HOME is a throwaway dir under tmp, not the real one", () => {
    const real = process.env.APIARY_TEST_REAL_HOME;
    expect(real, "global setup ran").toBeTruthy();
    expect(homedir()).not.toBe(real);
    expect(realpathSync(homedir()).startsWith(realpathSync(tmpdir()))).toBe(true);
  });
});
