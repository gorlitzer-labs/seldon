/**
 * Did the text we injected actually get submitted?
 *
 * Both bridges type into a TUI and then assume it worked. On 2026-09-10 that
 * assumption cost seven minutes of apparent silence: a room message reached a
 * Codex agent, the `@`-mention popup swallowed the Enter, and the message sat in
 * the composer while apiary reported success and moved on. Nobody learned it had
 * failed until a human read the pane.
 *
 * The check is deliberately narrow. After a submit, the text appears in the
 * *transcript* — that is success, not failure — so the presence of our text on
 * screen proves nothing. What distinguishes the two is where it sits: an
 * unsubmitted message is still in the composer, which both TUIs render as the
 * last prompt-marked block at the bottom of the screen.
 */

/** Prompt markers: Codex renders the composer with ›, Claude with ❯ (> on older builds). */
const PROMPT_MARKER = /^\s*[›❯>]\s?/;

/**
 * The composer's contents: everything from the last prompt marker down.
 *
 * Long messages wrap, so the marker line alone is not the whole composer — the
 * rest of the block below it belongs to the same input.
 */
export function composerBlock(lines: string[]): string {
  const tail = lines.slice(-25);
  let start = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (PROMPT_MARKER.test(tail[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return "";
  return tail.slice(start).join(" ");
}

/**
 * A stable fragment of the message to look for.
 *
 * The head of the text rather than the whole of it: the composer wraps, the pane
 * truncates, and a trailing `@mention` may already have been rewritten by the
 * very popup we are checking for — so the tail is exactly the part that cannot
 * be relied on. Whitespace is collapsed because wrapping introduces its own.
 */
export function submissionProbe(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * True when the message is still sitting in the composer, i.e. it was NOT
 * submitted. A message short enough to produce no usable probe is reported as
 * submitted rather than guessed at — a false "undelivered" would have the
 * caller resend, and a duplicate room message is worse than an unchecked one.
 */
export function composerStillHolds(lines: string[], text: string): boolean {
  const probe = submissionProbe(text);
  if (probe.length < 8) return false;
  const composer = composerBlock(lines).replace(/\s+/g, " ");
  return composer.includes(probe);
}
