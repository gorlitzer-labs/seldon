import type { ReactNode } from "react";

export type Line = ReactNode;

/** A faithful terminal window: mac chrome + monospace body whose lines reveal
 *  in sequence (keyed to `boot` so it replays when the beat is entered). */
export function Terminal({ title, boot, lines, width = 620 }:
  { title: string; boot: string; lines: Line[]; width?: number }) {
  return (
    <div className="term" style={{ maxWidth: width }}>
      <div className="tb"><i /><i /><i /><span className="t">{title}</span></div>
      <pre className="tbody" key={boot}>
        {lines.map((ln, i) => (
          <div key={i} className="tln" style={{ animationDelay: `${0.06 + i * 0.09}s` }}>{ln}</div>
        ))}
      </pre>
    </div>
  );
}
