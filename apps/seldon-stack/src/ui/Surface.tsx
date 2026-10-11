import { useBeat, useChapter, useView } from "../deck/deck";
import { ApiarySurface } from "./surfaces/Apiary";
import { DemerzelSurface } from "./surfaces/Demerzel";
import { StackSurface } from "./surfaces/Stack";
import { StackApartSurface } from "./surfaces/StackApart";
import { TypedTerminal } from "./surfaces/TypedTerminal";
import comb from "../content/captures/comb.txt?raw";
import foundation from "../content/captures/foundation.txt?raw";
import factory from "../content/captures/factory.txt?raw";
import bifrost from "../content/captures/bifrost.txt?raw";
import realSetup from "../content/captures/real-setup.txt?raw";
import realLine from "../content/captures/real-line.txt?raw";
import realComb from "../content/captures/real-comb.txt?raw";
import realBox from "../content/captures/real-box.txt?raw";
import realRun from "../content/captures/real-run.txt?raw";

/** The "real run" chapter: one capture per beat, all from one recorded run on a fresh Mac.
 *  The terminal is keyed by beat: TypedTerminal parses its text once on mount, and this chapter
 *  (unlike the module ones) swaps the capture between beats without leaving the surface. */
const REAL_RUN: Record<string, { title: string; text: string }> = {
  setup: { title: "a fresh Mac — real run", text: realSetup },
  plan: { title: "factory new — real run", text: realLine },
  secret: { title: "comb — real run", text: realComb },
  box: { title: "factory box — real run", text: realBox },
  build: { title: "the build — real run", text: realRun },
};

export function Surface() {
  const chapter = useChapter();
  const beat = useBeat();
  const view = useView();
  const on = view === "surface" || view === "combo";
  let inner = null;
  if (view === "combo")
    return <div className="surface on">{beat.id === "apart" ? <StackApartSurface /> : <StackSurface />}</div>;
  if (chapter.id === "real-run") {
    const r = REAL_RUN[beat.id];
    if (r) inner = <TypedTerminal key={"real-" + beat.id} title={r.title} text={r.text} boot={"real-" + beat.id} />;
  }
  switch (chapter.module) {
    case "apiary": inner = <ApiarySurface />; break;
    case "comb": inner = <TypedTerminal title="comb — real run" text={comb} boot="comb" />; break;
    case "foundation": inner = <TypedTerminal title="foundation — the seam" text={foundation} boot="foundation" />; break;
    case "factory": inner = <TypedTerminal title="factory — the floor" text={factory} boot="factory" />; break;
    case "bifrost": inner = <TypedTerminal title="bifrost — the bridge" text={bifrost} boot="bifrost" />; break;
    case "demerzel": inner = <DemerzelSurface />; break;
  }
  return <div className={"surface" + (on ? " on" : "")} aria-hidden={!on}>{on && inner}</div>;
}
