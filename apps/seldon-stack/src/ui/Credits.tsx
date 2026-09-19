import { MODULES, MODULE_ORDER } from "../content/modules";

/** A film-style credits roll over the hive. */
export function Credits() {
  return (
    <div className="credits" key="credits">
      <div className="creel">
        <div className="ctitle">THE SELDON STACK</div>
        <div className="csub">a software factory of AI agents</div>

        <div className="cgroup">
          <div className="clabel">the stack</div>
          {MODULE_ORDER.map((id) => {
            const m = MODULES[id];
            return (
              <div className="cmod" key={id}>
                <span className="cemb"><svg viewBox="0 0 40 40"><g dangerouslySetInnerHTML={{ __html: m.emblem }} /></svg></span>
                <span className="cnm">{m.nm}</span>
                <span className="crole">{m.role}</span>
                <span className="cver">{m.ver}</span>
              </div>
            );
          })}
        </div>

        <div className="cgroup">
          <div className="clabel">the lore</div>
          <div className="cline">Named for Asimov's <i>Foundation</i></div>
          <div className="cline">Seldon — the plan that runs itself</div>
          <div className="cline">Demerzel — the hand that steers it</div>
        </div>

        <div className="cgroup">
          <div className="clabel">built with</div>
          <div className="cline">React · three.js · react-three-fiber</div>
          <div className="cline">zustand · Vite</div>
          <div className="cline">Narration — ElevenLabs</div>
        </div>

        <div className="cgroup">
          <div className="clabel">made by</div>
          <div className="cby">Franco</div>
          <div className="cline">gorlitzer</div>
        </div>

        <div className="cgroup cfin">
          <div className="cbig">one idea → shipped</div>
          <div className="cline">weather-cli, live</div>
        </div>

        <div className="cthanks">thank you for watching</div>
      </div>
    </div>
  );
}
