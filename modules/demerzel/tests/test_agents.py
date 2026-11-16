"""The agents skill against a fake `seldon`, so no models and no real agents.

Run: python3 -m unittest discover tests
"""
from __future__ import annotations

import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import demerzel.skills  # noqa: E402,F401  (registers every tool)
from demerzel import tools  # noqa: E402
from demerzel.skills import agents as ag  # noqa: E402

LANES = [
    {"key": "claude:t1", "name": "tars", "projectName": "tars", "state": "needs-you", "waitingFor": "permission: Bash"},
    {"key": "codex:s1", "name": "fix-save-crash", "projectName": "stranded", "state": "working"},
    {"key": "claude:b1", "name": "botfighter", "projectName": "botfighter", "state": "idle"},
]

FAKE = """#!/bin/sh
log="$FAKE_DIR/calls"; echo "$*" >> "$log"
case "$1 $2" in
  "lanes --json") cat "$FAKE_DIR/lanes.json" ;;
  "lane read") printf '%s\\n' '{"text":"Done the refactor.\\n\\nShould I use **staging** or prod?\\n```\\ncode\\n```"}' ;;
  "lane say") [ "$3" = "codex:s1" ] && { echo "can't tell fix-save-crash: it is working" >&2; exit 1; }; echo ok ;;
  "ws pick") exit 0 ;;
  *) exit 2 ;;
esac
"""


class Fake(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        (self.dir / "lanes.json").write_text(json.dumps(LANES))
        bin_ = self.dir / "seldon"
        bin_.write_text(FAKE)
        bin_.chmod(bin_.stat().st_mode | stat.S_IEXEC)
        self.env = mock.patch.dict(os.environ, {"FAKE_DIR": str(self.dir)})
        self.cli = mock.patch.object(ag, "CLI", str(bin_))
        self.env.start(); self.cli.start()

    def tearDown(self):
        self.cli.stop(); self.env.stop()

    def calls(self):
        p = self.dir / "calls"
        return p.read_text().splitlines() if p.exists() else []

    def set_lanes(self, ls):
        (self.dir / "lanes.json").write_text(json.dumps(ls))


class WhatNeedsMe(Fake):
    def test_names_who_waits_and_on_what(self):
        self.assertEqual(ag.what_needs_me(), "1 needs you: tars, permission: Bash. 1 working.")

    def test_nobody_waiting(self):
        self.set_lanes([l for l in LANES if l["state"] != "needs-you"])
        self.assertEqual(ag.what_needs_me(), "No agent needs you. 1 working.")

    def test_seldon_missing_is_said_not_hidden(self):
        with mock.patch.object(ag, "CLI", "/nonexistent/seldon"):
            self.assertIn("cannot", ag.what_needs_me())


class Find(unittest.TestCase):
    def test_by_name_project_or_word(self):
        self.assertEqual(ag.find("tars", LANES)["key"], "claude:t1")
        self.assertEqual(ag.find("stranded", LANES)["key"], "codex:s1")
        self.assertEqual(ag.find("save crash", LANES)["key"], "codex:s1")

    def test_two_matches_is_no_match_unless_one_is_waiting(self):
        two = [{"key": "a", "name": "api", "projectName": "x", "state": "idle"},
               {"key": "b", "name": "api", "projectName": "y", "state": "idle"}]
        self.assertIsNone(ag.find("api", two))
        two[1]["state"] = "needs-you"
        self.assertEqual(ag.find("api", two)["key"], "b")


class ReadAndTell(Fake):
    def test_read_speaks_the_last_paragraph_without_markdown_or_code(self):
        self.assertEqual(ag.read_agent("tars"), "tars says: Should I use staging or prod?")

    def test_tell_types_into_the_agent(self):
        self.assertEqual(ag.tell_agent("tars", "use staging"), "Sent.")
        self.assertIn("lane say claude:t1 use staging", self.calls())

    def test_tell_reports_seldons_refusal(self):
        self.assertIn("working", ag.tell_agent("stranded", "yes"))

    def test_unknown_agent_types_nothing(self):
        self.assertIn("could not tell", ag.tell_agent("nobody", "yes"))
        self.assertFalse([c for c in self.calls() if c.startswith("lane say")])

    def test_tell_is_an_owner_write_that_asks_first(self):
        t = tools.TOOLS["tell_agent"]
        self.assertTrue(t.writes and t.confirm)

    def test_open_picks_it_in_the_workspace(self):
        self.assertEqual(ag.open_agent("tars"), "Opened tars.")
        self.assertIn("ws pick claude:t1", self.calls())


class Watcher(Fake):
    def test_announces_a_new_wait_once_and_again_after_it_moved_on(self):
        w = ag.AgentWatcher(); w.prime()
        self.assertEqual(w.poll(), [])                       # tars was already waiting
        ls = [dict(l) for l in LANES]; ls[1]["state"] = "needs-you"
        self.set_lanes(ls)
        fresh = w.poll()
        self.assertEqual([i.id for i in fresh], ["lane:codex:s1"])
        self.assertEqual(fresh[0].spoken(), "fix-save-crash on stranded needs a call. It is waiting for you.")
        self.assertEqual(w.poll(), [])                       # same wait: said once
        ls[1]["state"] = "working"; self.set_lanes(ls); w.poll()
        ls[1]["state"] = "needs-you"; self.set_lanes(ls)
        self.assertEqual([i.id for i in w.poll()], ["lane:codex:s1"])

    def test_seldon_down_forgets_nothing(self):
        w = ag.AgentWatcher(); w.prime()
        with mock.patch.object(ag, "CLI", "/nonexistent/seldon"):
            self.assertEqual(w.poll(), [])
        self.assertEqual(w.poll(), [])                       # tars is not re-announced


if __name__ == "__main__":
    unittest.main()
