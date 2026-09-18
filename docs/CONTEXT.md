# Context — Ubiquitous Language

One canonical term per concept, pinned before it propagates into schema/UI as contradictions. Each
entry: the term, its meaning, and `_Avoid_:` the rejected synonyms.

## Glossary

- **Demerzel** — the local voice assistant this repo builds. Python package `demerzel/`, browser front
  end `web/`. Renamed from Aria on 2026-09-05 for two reasons: the factory's own docs use "Aria" as
  an example agent name, so a decision spoken *by* Aria *from* Aria would be ambiguous; and the
  plosive /b/ makes a far stronger wake word. Parakeet was observed transcribing "Aria" as "Area".
  _Avoid_: Aria, Cortana, the assistant.

- **the factory** — Franko's agent orchestration stack: `factory` (CLI + supervisor), `foundation`
  (this seam), `apiary` (transport/hives). Demerzel is its voice, not a replacement for it.
  _Avoid_: the fleet, the swarm.

- **turn** — one exchange: endpoint fires, transcript decoded, reply generated, speech played.
  Measured from the endpoint decision, not from the user's last word — the two differ by the VAD
  hangover and conflating them is how latency claims get flattering. _Avoid_: round trip, exchange.

- **endpoint** — the moment the endpointer decides the user has stopped speaking. Currently a fixed
  600 ms VAD hangover; Smart Turn v3 is queued to replace it. _Avoid_: silence timeout, VAD stop.

- **the seam** — the four Foundation files (`QUEUE`, `WORKSTREAMS`, `DONE`, `FACTS`) that hold
  project state. Never hand-edited; every mutation goes through a `foundation` command.
  _Avoid_: the docs, the state files.
