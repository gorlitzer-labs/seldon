"""Skills that need no models: self-knowledge, what shipped, and the foundation call.

Stdlib unittest on purpose -- the voice stack is heavy (mlx, kokoro), and none of this
touches it, so CI can run it with a bare python3. Run: python3 -m unittest discover tests
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import demerzel.skills  # noqa: E402,F401  (registers every tool)
from demerzel import identity, tools  # noqa: E402
from demerzel.skills import factory as fskill, shipped  # noqa: E402


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


class TmpCase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._td.name).resolve()

    def tearDown(self):
        self._td.cleanup()


class FoundationCommand(unittest.TestCase):
    def test_prefers_installed_foundation(self):
        with mock.patch.object(fskill.shutil, "which", return_value="/x/foundation"):
            self.assertEqual(fskill._foundation_cmd(), ["foundation"])

    def test_falls_back_to_npm_not_the_retired_github_repo(self):
        with mock.patch.object(fskill.shutil, "which", return_value=None):
            cmd = fskill._foundation_cmd()
        self.assertEqual(cmd, ["npx", "-y", "@gorlitzer-labs/foundation"])
        self.assertFalse(any("github:" in c for c in cmd))


class Speech(unittest.TestCase):
    def test_clean_subject(self):
        self.assertEqual(shipped.clean_subject("feat(hud): a crosshair (#12)"), "a crosshair")
        self.assertEqual(shipped.clean_subject("seldon adopt: put a repo on the line (#59)"),
                         "seldon adopt: put a repo on the line")

    def test_spoken_ago(self):
        self.assertEqual(shipped.spoken_ago(30), "just now")
        self.assertEqual(shipped.spoken_ago(60), "1 minute ago")
        self.assertEqual(shipped.spoken_ago(7200), "2 hours ago")
        self.assertEqual(shipped.spoken_ago(3 * 86400), "3 days ago")


class WhatShipped(TmpCase):
    def make_project(self):
        origin, work = self.tmp / "origin.git", self.tmp / "game"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(origin))
        git(self.tmp, "clone", "-q", str(origin), str(work))
        for msg in ("feat: first thing (#1)", "fix(world): second thing (#2)", "the newest thing (#3)"):
            git(work, "commit", "-q", "--allow-empty", "-m", msg)
        git(work, "push", "-q", "origin", "HEAD:main")
        git(work, "fetch", "-q", "origin")
        return work

    def test_newest_first_spoken_clean_with_freshness(self):
        work = self.make_project()
        with mock.patch.object(shipped, "resolve_project", return_value=work):
            out = shipped.what_shipped("game")
        self.assertIn("Last on game", out)
        self.assertIn("the newest thing.", out)
        self.assertLess(out.index("the newest thing"), out.index("second thing"))
        self.assertNotIn("#3", out)
        self.assertIn("as of the last fetch", out)

    def test_reads_only_never_fetches(self):
        work = self.make_project()
        calls = []
        real = shipped._git
        def spy(repo, *args):
            calls.append(args[0])
            return real(repo, *args)
        with mock.patch.object(shipped, "resolve_project", return_value=work), \
             mock.patch.object(shipped, "_git", side_effect=spy):
            shipped.what_shipped("game")
        self.assertTrue(calls)
        self.assertFalse({"fetch", "pull", "push", "remote"} & set(calls), calls)

    def test_unknown_project(self):
        with mock.patch.object(shipped, "resolve_project", return_value=None):
            self.assertIn("could not find", shipped.what_shipped("nope"))

    def test_not_a_repo(self):
        with mock.patch.object(shipped, "resolve_project", return_value=self.tmp):
            self.assertIn("not a git repository", shipped.what_shipped("plain"))

    def test_her_own_name_finds_the_monorepo(self):
        work = self.make_project()
        with mock.patch.object(shipped, "resolve_project", return_value=None), \
             mock.patch.object(shipped, "find_monorepo", return_value=work):
            self.assertIn("the newest thing", shipped.what_shipped("Seldon"))


class Versions(TmpCase):
    def setUp(self):
        super().setUp()
        self.repo, self.root = self.tmp / "repo", self.tmp / "global"
        for _, rel, _ in shipped.PACKAGES:
            p = self.repo / rel
            p.mkdir(parents=True)
            (p / "package.json").write_text(json.dumps({"version": "1.0.0"}))

    def install(self, npm_name, version):
        d = self.root / npm_name
        d.mkdir(parents=True)
        (d / "package.json").write_text(json.dumps({"version": version}))

    def test_all_match(self):
        for _, _, n in shipped.PACKAGES:
            self.install(n, "1.0.0")
        self.assertEqual(shipped.compare_versions(self.repo, [self.root]),
                         f"All {len(shipped.PACKAGES)} installed tools match the repo.")

    def test_behind_and_missing_are_named(self):
        for spoken, _, n in shipped.PACKAGES:
            if spoken == "factory":
                self.install(n, "0.9.0")
            elif spoken != "comb":
                self.install(n, "1.0.0")
        out = shipped.compare_versions(self.repo, [self.root])
        self.assertIn("factory is 0.9.0 here but the repo has 1.0.0", out)
        self.assertIn("Not installed: comb", out)


class Identity(TmpCase):
    def make_monorepo(self, where):
        (where / identity.MARKER).mkdir(parents=True)
        return where

    def test_env_wins(self):
        repo = self.make_monorepo(self.tmp / "seldon")
        with mock.patch.dict(os.environ, {"DEMERZEL_SOURCE": str(repo)}):
            self.assertEqual(identity.find_monorepo(), repo)

    def test_registry_entry(self):
        repo = self.make_monorepo(self.tmp / "somewhere" / "seldon")
        reg = self.tmp / "hives.json"
        reg.write_text(json.dumps([{"name": "stranded", "dir": str(self.tmp / "x")},
                                   {"name": "seldon", "dir": str(repo)}]))
        with mock.patch.dict(os.environ, {"DEMERZEL_SOURCE": ""}), \
             mock.patch.object(identity, "REGISTRY", reg), \
             mock.patch.object(identity, "HERE", self.tmp / "installed" / "demerzel"):
            self.assertEqual(identity.find_monorepo(), repo)

    def test_shallow_search_under_file_roots(self):
        repo = self.make_monorepo(self.tmp / "desk" / "work" / "seldon")
        with mock.patch.dict(os.environ, {"DEMERZEL_SOURCE": "", "DEMERZEL_FILE_ROOTS": str(self.tmp / "desk")}), \
             mock.patch.object(identity, "REGISTRY", self.tmp / "none.json"), \
             mock.patch.object(identity, "HERE", self.tmp / "installed" / "demerzel"):
            self.assertEqual(identity.find_monorepo(), repo)

    def test_prompt_names_her_code_and_the_rule(self):
        repo = self.make_monorepo(self.tmp / "seldon")
        with mock.patch.object(identity, "find_monorepo", return_value=repo):
            p = identity.as_prompt()
        self.assertIn(str(repo / "modules" / "demerzel"), p)
        self.assertIn("Seldon stack", p)
        self.assertIn("never change code yourself", p)

    def test_bonsai_brain_system_prompt_includes_identity(self):
        # models.py imports mlx + numpy at the top for the voice; only SYSTEM is needed
        # here, so stand those in rather than making CI install the ML stack.
        heavy = {m: mock.MagicMock() for m in ("mlx", "mlx.core", "numpy")}
        with mock.patch.dict(sys.modules, heavy):
            from demerzel import brain_bonsai
            with mock.patch.object(identity, "find_monorepo", return_value=None):
                self.assertIn("Seldon stack", brain_bonsai._system())


class Registry(unittest.TestCase):
    def test_new_tools_registered_read_only_and_local(self):
        for name in ("what_shipped", "stack_versions"):
            t = tools.TOOLS[name]
            self.assertFalse(t.writes, name)
            self.assertTrue(t.local, name)


if __name__ == "__main__":
    unittest.main()
