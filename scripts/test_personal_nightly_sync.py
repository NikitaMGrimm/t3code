import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("personal_nightly_sync", Path(__file__).with_name("personal-nightly.py"))
nightly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nightly)


class PrSynchronizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        nightly.git("init", "-b", "personal-nightly", str(self.repo))
        nightly.git("config", "user.name", "test", cwd=self.repo)
        nightly.git("config", "user.email", "test@example.invalid", cwd=self.repo)
        (self.repo / "shared.txt").write_text("base\n")
        self.commit("official base")
        self.tag = "v0.0.46-nightly.20261012.1"
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("branch", "upstream", cwd=self.repo)
        self.config = {"repository": "NikitaMGrimm/t3code", "branch": "personal-nightly",
                       "upstreamRepository": "pingdotgg/t3code", "upstreamTag": self.tag,
                       "prBaseline": self.head(), "pullRequests": []}
        (self.repo / "personal-nightly.json").write_text(json.dumps(self.config))
        (self.repo / "personal.txt").write_text("my independent fix\n")
        self.commit("personal overlay")

    def head(self):
        return nightly.git("rev-parse", "HEAD", cwd=self.repo).stdout.strip()

    def commit(self, message):
        nightly.git("add", ".", cwd=self.repo)
        nightly.git("commit", "-m", message, cwd=self.repo)
        return self.head()

    def pull(self, number, files, from_ref="upstream", base_ref="main"):
        base = nightly.git("rev-parse", from_ref, cwd=self.repo).stdout.strip()
        nightly.git("checkout", "-B", f"pr-{number}", from_ref, cwd=self.repo)
        for name, text in files.items():
            (self.repo / name).write_text(text)
        head = self.commit(f"PR {number}")
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        return {"number": number, "title": f"Fix {number}", "headSha": head, "baseSha": base,
                "baseRef": base_ref, "headRef": f"pr-{number}"}

    def prepare(self, pulls, releases=(), resolutions=None):
        return nightly.prepare(self.repo, self.tag, "123", releases, pulls, resolutions)

    def manifest(self):
        return json.loads((self.repo / "personal-nightly.json").read_text())

    def test_new_updated_force_pushed_and_closed_prs_replace_the_previous_patch_set(self):
        first = self.pull(1, {"shared.txt": "first PR version\n"})
        self.assertEqual(self.prepare([first])["phase"], "building")
        previous = self.head()
        updated = self.pull(1, {"shared.txt": "replacement PR version\n"})
        added = self.pull(2, {"new.txt": "new PR\n"})
        status = self.prepare([added, updated])
        self.assertEqual(status["phase"], "building")
        self.assertEqual((self.repo / "shared.txt").read_text(), "replacement PR version\n")
        self.assertEqual((self.repo / "personal.txt").read_text(), "my independent fix\n")
        nightly.git("merge-base", "--is-ancestor", previous, self.head(), cwd=self.repo)
        self.prepare([updated])
        self.assertFalse((self.repo / "new.txt").exists())
        self.prepare([])
        self.assertEqual((self.repo / "shared.txt").read_text(), "base\n")
        self.assertEqual(self.manifest()["pullRequests"], [])

    def test_direct_fix_merged_after_an_earlier_sync_survives_a_pr_refresh(self):
        first = self.pull(1, {"pr.txt": "old\n"})
        self.prepare([first])
        (self.repo / "personal.txt").write_text("a newer direct fix\n")
        self.commit("direct personal fix")
        updated = self.pull(1, {"pr.txt": "new\n"})
        self.prepare([updated])
        self.assertEqual((self.repo / "personal.txt").read_text(), "a newer direct fix\n")
        self.assertEqual((self.repo / "pr.txt").read_text(), "new\n")

    def test_upstream_and_pr_conflicts_preserve_the_checkout_and_last_release(self):
        first = self.pull(1, {"shared.txt": "PR change\n"})
        nightly.git("checkout", "upstream", cwd=self.repo)
        (self.repo / "shared.txt").write_text("incompatible upstream change\n")
        self.commit("new upstream")
        self.tag = "v0.0.46-nightly.20261012.2"
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        before = self.head()
        status = self.prepare([first])
        self.assertEqual(status["phase"], "conflict")
        self.assertEqual(status["conflictPullRequest"], 1)
        self.assertEqual(status["conflicts"], ["shared.txt"])
        self.assertEqual(self.head(), before)
        self.assertEqual((self.repo / "shared.txt").read_text(), "base\n")
        self.assertEqual(nightly.git("status", "--porcelain", cwd=self.repo).stdout, "")

    def test_personal_overlay_conflict_does_not_overwrite_the_existing_fix(self):
        (self.repo / "shared.txt").write_text("independent personal change\n")
        self.commit("personal shared fix")
        first = self.pull(1, {"shared.txt": "PR change\n"})
        before = self.head()
        status = self.prepare([first])
        self.assertEqual(status["phase"], "conflict")
        self.assertEqual(status["conflicts"], ["shared.txt"])
        self.assertEqual(self.head(), before)
        self.assertEqual((self.repo / "shared.txt").read_text(), "independent personal change\n")

    def test_dirty_or_untracked_work_is_preserved_and_refuses_assembly(self):
        (self.repo / "untracked.txt").write_text("work to preserve")
        before = self.head()
        with self.assertRaisesRegex(ValueError, "clean checkout"):
            self.prepare([])
        self.assertEqual(self.head(), before)
        self.assertEqual((self.repo / "untracked.txt").read_text(), "work to preserve")

    def test_stack_order_and_diffs_exclude_unreleased_base_changes(self):
        parent = self.pull(20, {"parent.txt": "parent\n"})
        child = self.pull(10, {"child.txt": "child\n"}, "pr-20", "pr-20")
        self.assertEqual([pull["number"] for pull in nightly.ordered_pull_requests([child, parent])], [20, 10])
        nightly.git("checkout", "upstream", cwd=self.repo)
        (self.repo / "unreleased.txt").write_text("not in the official nightly\n")
        self.commit("unreleased upstream")
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        other = self.pull(30, {"other.txt": "other\n"})
        self.prepare([child, parent, other])
        for name in ["parent.txt", "child.txt", "other.txt"]:
            self.assertTrue((self.repo / name).exists())
        self.assertFalse((self.repo / "unreleased.txt").exists())

    def test_cyclic_branch_dependencies_stop(self):
        first = self.pull(1, {"one.txt": "one"})
        second = self.pull(2, {"two.txt": "two"})
        first["baseRef"] = second["headRef"]
        second["baseRef"] = first["headRef"]
        with self.assertRaisesRegex(ValueError, "cyclic"):
            self.prepare([first, second])

    def test_published_unchanged_heads_skip_but_changed_prs_build(self):
        first = self.pull(1, {"shared.txt": "old\n"})
        self.prepare([first])
        release = {"draft": False, "tag_name": self.tag, "target_commitish": self.head()}
        self.assertTrue(self.prepare([first], [release])["skipBuild"])
        updated = self.pull(1, {"shared.txt": "new\n"})
        self.assertNotIn("skipBuild", self.prepare([updated], [release]))

    def test_candidate_verification_rejects_new_pr_heads_and_direct_pushes(self):
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        first = self.pull(1, {"pr.txt": "old"})
        status = {"baseCommit": self.head(), "inputs": {"pullRequests": nightly.pull_request_inputs([first])}}
        self.assertTrue(nightly.candidate_is_current(self.repo, status, self.config, [first]))
        updated = self.pull(1, {"pr.txt": "new"})
        self.assertFalse(nightly.candidate_is_current(self.repo, status, self.config, [updated]))
        candidate = self.prepare([first])["candidateCommit"]
        status["candidateCommit"] = candidate
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        self.assertTrue(nightly.candidate_is_current(self.repo, status, self.config, [first]))
        (self.repo / "personal.txt").write_text("new direct fix")
        self.commit("new direct fix")
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        self.assertFalse(nightly.candidate_is_current(self.repo, status, self.config, [first]))

    def test_git_reuses_a_recorded_resolution_but_stops_on_a_different_conflict(self):
        first = self.pull(1, {"shared.txt": "one\n"})
        second = self.pull(2, {"shared.txt": "two\n"})
        recording = Path(self.temp.name) / "recording"
        nightly.git("clone", "--shared", "--no-checkout", str(self.repo), str(recording))
        nightly.git("config", "user.name", "test", cwd=recording)
        nightly.git("config", "user.email", "test@example.invalid", cwd=recording)
        nightly.git("checkout", "--detach", first["headSha"], cwd=recording)
        self.assertEqual(nightly.merge_delta(recording, second["baseSha"], second["headSha"]), ["shared.txt"])
        (recording / "shared.txt").write_text("one and two\n")
        nightly.git("-c", "rerere.enabled=true", "rerere", cwd=recording)
        cache = recording / ".git" / "rr-cache"
        resolutions = {folder.name: {name: (folder / name).read_text() for name in ("preimage", "postimage")}
                       for folder in cache.iterdir()}
        self.assertEqual(self.prepare([first, second], resolutions=resolutions)["phase"], "building")
        self.assertEqual((self.repo / "shared.txt").read_text(), "one and two\n")
        changed = self.pull(2, {"shared.txt": "different change\n"})
        self.assertEqual(self.prepare([first, changed], resolutions=resolutions)["phase"], "conflict")


class InputDiscoveryTests(unittest.TestCase):
    def node(self, number):
        return {"number": number, "title": f"Fix {number}", "state": "OPEN",
                "headRefOid": "a" * 40, "headRefName": f"pr-{number}",
                "baseRefOid": "b" * 40, "baseRefName": "main", "author": {"login": "NikitaMGrimm"}}

    def response(self, numbers, more=False, cursor=None):
        return subprocess.CompletedProcess([], 0, json.dumps({"data": {"search": {
            "issueCount": 2, "nodes": [self.node(number) for number in numbers],
            "pageInfo": {"hasNextPage": more, "endCursor": cursor}}}}), "")

    def test_discovery_paginates_and_includes_all_open_authored_prs(self):
        with patch.object(nightly.subprocess, "run", side_effect=[self.response([2], True, "next"), self.response([1])]) as run:
            pulls = nightly.discover_pull_requests({"repository": "NikitaMGrimm/t3code", "upstreamRepository": "pingdotgg/t3code"})
        self.assertEqual([pull["number"] for pull in pulls], [1, 2])
        self.assertIn("cursor=next", run.call_args_list[-1].args[0])

    def test_partial_or_duplicate_discovery_cannot_remove_existing_prs(self):
        config = {"repository": "NikitaMGrimm/t3code", "upstreamRepository": "pingdotgg/t3code"}
        error = subprocess.CompletedProcess([], 0, json.dumps({"errors": [{"message": "rate limited"}]}), "")
        for responses in [[error], [self.response([1], True, "next"), self.response([1])]]:
            with patch.object(nightly.subprocess, "run", side_effect=responses), self.assertRaises(RuntimeError):
                nightly.discover_pull_requests(config)

    def test_debounce_resets_on_patch_changes_without_using_commit_dates_or_reviews(self):
        first = {"number": 1, "headSha": "a" * 40, "baseRef": "main", "baseSha": "b" * 40}
        inputs = {"pullRequests": nightly.pull_request_inputs([first])}
        observed, stable = nightly.debounce_inputs({}, inputs, 100)
        self.assertFalse(stable)
        reviewed = dict(first, title="new description", baseSha="c" * 40)
        same_inputs = {"pullRequests": nightly.pull_request_inputs([reviewed])}
        self.assertEqual(inputs, same_inputs)
        self.assertFalse(nightly.debounce_inputs(observed, same_inputs, 219)[1])
        self.assertTrue(nightly.debounce_inputs(observed, same_inputs, 220)[1])
        updated = {"pullRequests": nightly.pull_request_inputs([dict(first, headSha="d" * 40)])}
        reset, stable = nightly.debounce_inputs(observed, updated, 230)
        self.assertFalse(stable)
        self.assertEqual(reset["observedAt"], 230)


if __name__ == "__main__":
    unittest.main()
