import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRooms, looseRooms } from "../lib/projects.mjs";

test("listRooms: only rooms whose server is alive, from apiary's session files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"));
  fs.writeFileSync(path.join(dir, "room_stranded.json"), JSON.stringify({ roomName: "stranded", pid: 11 }));
  fs.writeFileSync(path.join(dir, "room_dead.json"), JSON.stringify({ roomName: "dead", pid: 22 }));
  fs.writeFileSync(path.join(dir, "room_broken.json"), "{not json");
  fs.writeFileSync(path.join(dir, "claude_Coordinator.json"), JSON.stringify({ roomName: "nope", pid: 11 }));
  const rooms = listRooms(dir, (pid) => pid === 11);
  assert.deepEqual(rooms, [{ name: "stranded", pid: 11 }]);
  assert.deepEqual(listRooms(path.join(dir, "missing")), []);
});

test("looseRooms: the rooms no project on the line owns", () => {
  const rooms = [{ name: "seldon", pid: 1 }, { name: "stranded", pid: 2 }, { name: "sprouts-joey", pid: 3 }];
  assert.deepEqual(looseRooms(rooms, [{ name: "seldon" }]).map((r) => r.name), ["stranded", "sprouts-joey"]);
  assert.deepEqual(looseRooms(rooms, null).length, 3);
});
