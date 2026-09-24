// Pure helpers for publish-all.mjs, kept separate so they can be tested without npm.

// npm now stages a publish for a while (~20 min seen) before the version is visible:
// `npm view` says it is missing, and publishing it again is refused with
//   409 Conflict - Cannot publish over previously staged version "x.y.z".
// That answer means the version IS taken and on its way — not a failure.
export function classifyPublishError(stderr) {
  const s = String(stderr || "");
  if (/E409/.test(s) && /previously staged version/i.test(s)) return "staged";
  return "error";
}
