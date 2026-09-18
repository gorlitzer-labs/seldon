import { useEffect } from "react";
import { Scene } from "./three/Scene";
import { Story } from "./ui/Story";
import { Rail } from "./ui/Rail";
import { Controls } from "./ui/Controls";
import { Surface } from "./ui/Surface";
import { Syllabus } from "./ui/Syllabus";
import { Narrator } from "./ui/Narrator";
import { Credits } from "./ui/Credits";
import { chapterAt } from "./deck/deck";
import { useDeck } from "./deck/deck";
import { useHashRoute } from "./deck/useHashRoute";

export function App() {
  const view = useDeck((s) => s.view);
  const isCredits = useDeck((s) => chapterAt(s.index).id === "credits");
  useHashRoute();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = useDeck.getState();
      if (d.view === "syllabus") { if (e.key === "Enter") d.enter(0); return; }
      if (e.key === "ArrowRight" || e.key === " ") { d.next(); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { d.prev(); e.preventDefault(); }
      else if (e.key === "Escape") d.home();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Scene />
      <div className="scrim" data-view={view} />
      {view === "reel" ? (
        <>
          {isCredits ? (
            <Credits />
          ) : (
            <>
              <Story />
              <Surface />
              <Rail />
            </>
          )}
          <Controls />
          <Narrator />
        </>
      ) : (
        <Syllabus />
      )}
    </>
  );
}
