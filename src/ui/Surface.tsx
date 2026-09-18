import { useChapter, useView } from "../deck/deck";
import { ApiarySurface } from "./surfaces/Apiary";
import { DemerzelSurface } from "./surfaces/Demerzel";
import { StackSurface } from "./surfaces/Stack";
import { TypedTerminal } from "./surfaces/TypedTerminal";
import comb from "../content/captures/comb.txt?raw";
import foundation from "../content/captures/foundation.txt?raw";
import factory from "../content/captures/factory.txt?raw";
import bifrost from "../content/captures/bifrost.txt?raw";

export function Surface() {
  const chapter = useChapter();
  const view = useView();
  const on = view === "surface" || view === "combo";
  let inner = null;
  if (view === "combo") return <div className={"surface" + (on ? " on" : "")}><StackSurface /></div>;
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
