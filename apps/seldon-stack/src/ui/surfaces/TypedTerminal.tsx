import { useEffect, useRef, useState } from "react";

type Block = { cmd: string; out: string[] };
function parse(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\s+$/, "").split("\n")) {
    if (raw.startsWith("$ ")) blocks.push({ cmd: raw.slice(2), out: [] });
    else if (blocks.length) blocks[blocks.length - 1].out.push(raw);
  }
  // trim leading/trailing blank output lines per block
  for (const b of blocks) { while (b.out[0] === "") b.out.shift(); while (b.out.at(-1) === "") b.out.pop(); }
  return blocks;
}
const outClass = (l: string) => {
  const t = l.trim();
  if (t.startsWith("■") || t.startsWith("✗") || t.includes("REACHABLE")) return "bad";   // needs-you / error
  if (t.startsWith("◐")) return "work";                                                   // working
  if (t.startsWith("●") || t.startsWith("✓") || t.includes("✓") || /sealed off from the box|work mount OK/.test(t)) return "ok"; // idle / success
  if (t.startsWith("·") || t.startsWith("(") || t.startsWith("#") || t.startsWith("---") ||
      t.startsWith("📦") || t.startsWith("sealed") || t.startsWith("public key") || t.startsWith("private key")) return "dim";
  return "";
};
/** command echo with the binary (first word) highlighted */
function Cmd({ text, caret }: { text: string; caret?: boolean }) {
  const sp = text.indexOf(" ");
  const bin = sp < 0 ? text : text.slice(0, sp);
  const rest = sp < 0 ? "" : text.slice(sp);
  return (
    <div className="cline">
      <span className="prompt">$</span> <span className="bin">{bin}</span><span className="args">{rest}</span>
      {caret && <span className="caret" />}
    </div>
  );
}

export function TypedTerminal({ title, text, boot }: { title: string; text: string; boot: string | number }) {
  const blocks = useRef(parse(text)).current;
  const [bi, setBi] = useState(0);
  const [typed, setTyped] = useState("");
  const [cmdDone, setCmdDone] = useState(false);
  const [outN, setOutN] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setBi(0); setTyped(""); setCmdDone(false); setOutN(0); setDone(false);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    let t = 350;
    blocks.forEach((b, i) => {
      const per = Math.min(24, 640 / Math.max(1, b.cmd.length));
      at(t, () => { setBi(i); setTyped(""); setCmdDone(false); setOutN(0); });
      for (let c = 1; c <= b.cmd.length; c++) { const cc = c; at(t += per, () => setTyped(b.cmd.slice(0, cc))); }
      at(t += 260, () => setCmdDone(true));
      for (let k = 1; k <= b.out.length; k++) { const kk = k; at(t += 95, () => setOutN(kk)); }
      // promote the finished block into the settled list so the LAST one stays visible
      at(t += 40, () => { setBi(i + 1); setTyped(""); setCmdDone(false); setOutN(0); });
      t += 440;
    });
    at(t, () => setDone(true));
    return () => timers.forEach(clearTimeout);
  }, [boot, blocks]);

  return (
    <div className="term typed" key={boot}>
      <div className="tb"><i /><i /><i /><span className="t">{title}</span></div>
      <div className="tbody">
        {blocks.slice(0, bi).map((b, i) => (
          <div className="tblock" key={i}>
            <Cmd text={b.cmd} />
            {b.out.map((l, j) => <div key={j} className={"oline " + outClass(l)}>{l || " "}</div>)}
          </div>
        ))}
        {!done && blocks[bi] && (
          <div className="tblock">
            <Cmd text={typed} caret={!cmdDone} />
            {blocks[bi].out.slice(0, outN).map((l, j) => <div key={j} className={"oline " + outClass(l)}>{l || " "}</div>)}
          </div>
        )}
        {done && <div className="cline"><span className="prompt">$</span> <span className="caret" /></div>}
      </div>
    </div>
  );
}
