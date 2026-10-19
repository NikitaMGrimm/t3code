import importlib.util
import json
import os
import sys
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

    def remote(self):
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)

    def run_prepare(self, pulls, now, forced=False, manual=False, include="", remove="", stable_inputs=""):
        env = {"RUNNER_TEMP": self.temp.name, "GITHUB_OUTPUT": str(Path(self.temp.name) / "output"),
               "GITHUB_EVENT_NAME": "workflow_dispatch" if forced or manual else "schedule",
               "GITHUB_RUN_ID": "123", "PERSONAL_NIGHTLY_FORCE": "true" if forced else "false",
               "PERSONAL_NIGHTLY_INCLUDE_PRS": include, "PERSONAL_NIGHTLY_REMOVE_PRS": remove,
               "PERSONAL_NIGHTLY_STABLE_INPUTS": stable_inputs}
        args = ["personal-nightly", "prepare", "--sync-prs", "--tag", self.tag]
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", args), \
                patch.dict(os.environ, env), patch.object(nightly.time, "time", return_value=now), \
                patch.object(nightly, "discover_included_pull_requests", return_value=pulls), \
                patch.object(nightly, "fetch_pull_requests") as fetch:
            nightly.main()
        return json.loads((Path(self.temp.name) / "personal-nightly-status.json").read_text()), fetch

    def test_cooldown_coalesces_changed_inputs_without_fetching_or_building(self):
        self.remote()
        first = self.pull(1, {"pr.txt": "first\n"})
        previous = {"phase": "ready", "sequence": 1, "releasedVersion": self.tag.removeprefix("v")}
        nightly.write_status(self.repo, previous)
        timing = {"completedAt": 100, "sequence": 1}
        nightly.write_state(self.repo, "build-timing.json", timing)
        nightly.write_state(self.repo, "inputs.json", {
            "inputs": {"upstreamTag": self.tag, "pullRequests": nightly.pull_request_inputs([first])},
            "observedAt": 1,
        })
        head = self.head()
        status, fetch = self.run_prepare([first], 500)
        self.assertEqual(status["phase"], "debouncing")
        fetch.assert_not_called()
        self.assertEqual(self.head(), head)
        updated = self.pull(1, {"pr.txt": "latest\n"})
        status, fetch = self.run_prepare([updated], 600)
        fetch.assert_not_called()
        self.assertEqual(status["phase"], "debouncing")
        self.assertEqual(nightly.read_state(self.repo, "status.json"), previous)
        self.assertEqual(nightly.read_state(self.repo, "build-timing.json"), timing)
        status, fetch = self.run_prepare([updated], 1900)
        fetch.assert_called_once()
        self.assertEqual(status["phase"], "building")
        self.assertEqual((self.repo / "pr.txt").read_text(), "latest\n")

    def test_only_an_explicit_manual_force_bypasses_cooldown_and_debounce(self):
        self.remote()
        first = self.pull(1, {"pr.txt": "new\n"})
        nightly.write_state(self.repo, "build-timing.json", {"completedAt": 100, "sequence": 1})
        status, fetch = self.run_prepare([first], 101, forced=True)
        fetch.assert_called_once()
        self.assertEqual(status["phase"], "building")
        self.assertEqual((self.repo / "pr.txt").read_text(), "new\n")

    def test_vps_digest_skips_duplicate_debounce_but_preserves_cooldown(self):
        self.remote()
        first = self.pull(1, {"pr.txt": "new\n"})
        inputs = {"upstreamTag": self.tag, "pullRequests": nightly.pull_request_inputs([first]),
                  "resolutions": nightly.hashlib.sha256(json.dumps({}, sort_keys=True).encode()).hexdigest()}
        snapshot = {"inputs": inputs, "baseCommit": self.head()}
        digest = nightly.hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        nightly.write_state(self.repo, "build-timing.json", {"completedAt": 100, "sequence": 1})
        status, fetch = self.run_prepare([first], 101, manual=True, stable_inputs=digest)
        self.assertEqual(status["phase"], "debouncing")
        fetch.assert_not_called()
        status, fetch = self.run_prepare([first], 1900, manual=True, stable_inputs=digest)
        self.assertEqual(status["phase"], "building")
        fetch.assert_called_once()

    def test_vps_digest_is_invalid_after_a_personal_branch_push(self):
        inputs = {"upstreamTag": self.tag, "pullRequests": [], "resolutions": "abc"}
        snapshot = {"inputs": inputs, "baseCommit": self.head()}
        digest = nightly.hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        self.assertTrue(nightly.inputs_stabilized_externally(inputs, self.head(), digest))
        (self.repo / "personal.txt").write_text("another fix\n")
        self.commit("personal push")
        self.assertFalse(nightly.inputs_stabilized_externally(inputs, self.head(), digest))

    def test_stale_vps_digest_does_not_skip_debounce(self):
        self.remote()
        first = self.pull(1, {"pr.txt": "new\n"})
        inputs = {"upstreamTag": self.tag, "pullRequests": nightly.pull_request_inputs([first]),
                  "resolutions": nightly.hashlib.sha256(json.dumps({}, sort_keys=True).encode()).hexdigest()}
        nightly.write_state(self.repo, "inputs.json", {"inputs": inputs, "observedAt": 1})
        status, fetch = self.run_prepare([first], 10000, manual=True, stable_inputs="a" * 64)
        self.assertEqual(status["phase"], "debouncing")
        fetch.assert_not_called()

    def test_an_ordinary_manual_check_does_not_bypass_cooldown(self):
        self.remote()
        first = self.pull(1, {"pr.txt": "new\n"})
        nightly.write_state(self.repo, "build-timing.json", {"completedAt": 100, "sequence": 1})
        status, fetch = self.run_prepare([first], 500, manual=True)
        fetch.assert_not_called()
        self.assertEqual(status["phase"], "debouncing")

    def test_failed_build_records_completion_time_and_unchanged_checks_do_not_extend_it(self):
        self.remote()
        status = self.prepare([])
        status_path = Path(self.temp.name) / "personal-nightly-status.json"
        status_path.write_text(json.dumps(status))
        args = ["personal-nightly", "status", "--phase", "failed"]
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", args), \
                patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name}), \
                patch.object(nightly.time, "time", return_value=300):
            nightly.main()
        timing = nightly.read_state(self.repo, "build-timing.json")
        self.assertEqual(timing["completedAt"], 300)
        self.assertEqual(timing["sequence"], status["sequence"])
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", args), \
                patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name}), \
                patch.object(nightly.time, "time", return_value=1000):
            nightly.main()
        self.assertEqual(nightly.read_state(self.repo, "build-timing.json"), timing)
        phase, fetch = self.run_prepare([], 400)
        self.assertEqual(phase["phase"], "debouncing")
        fetch.assert_not_called()
        self.assertEqual(nightly.read_state(self.repo, "build-timing.json"), timing)

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

    def test_owner_fix_automatically_recovers_a_previously_conflicting_selected_pr(self):
        self.remote()
        first = self.pull(1, {"shared.txt": "PR change\n"})
        nightly.git("checkout", "upstream", cwd=self.repo)
        (self.repo / "shared.txt").write_text("new upstream change\n")
        self.commit("new official nightly")
        self.tag = "v0.0.46-nightly.20261012.2"
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        status, _ = self.run_prepare([first], 100, forced=True, include="1")
        self.assertEqual(status["phase"], "conflict")
        self.assertEqual(nightly.read_state(self.repo, "included-prs.json")["numbers"], [1])
        suppressed, fetch = self.run_prepare([first], 200)
        self.assertEqual(suppressed["phase"], "debouncing")
        fetch.assert_not_called()
        fixed = self.pull(1, {"shared.txt": "owner reconciled the new upstream change\n"})
        waiting, _ = self.run_prepare([fixed], 300)
        self.assertEqual(waiting["phase"], "debouncing")
        recovered, fetch = self.run_prepare([fixed], 420)
        fetch.assert_called_once()
        self.assertEqual(recovered["phase"], "building")
        self.assertEqual((self.repo / "shared.txt").read_text(), "owner reconciled the new upstream change\n")
        self.assertEqual((self.repo / "personal.txt").read_text(), "my independent fix\n")

    def test_conflict_between_selected_prs_waits_for_a_compatible_new_head(self):
        first = self.pull(1, {"shared.txt": "first PR\n"})
        second = self.pull(2, {"shared.txt": "conflicting second PR\n"})
        before = self.head()
        status = self.prepare([first, second])
        self.assertEqual(status["phase"], "conflict")
        self.assertEqual(status["conflictPullRequest"], 2)
        self.assertEqual(self.head(), before)
        fixed = self.pull(2, {"other.txt": "second PR without the overlapping edit\n"})
        self.assertEqual(self.prepare([first, fixed])["phase"], "building")
        self.assertEqual((self.repo / "shared.txt").read_text(), "first PR\n")
        self.assertTrue((self.repo / "other.txt").exists())

    def test_selected_merged_pr_transitions_to_upstream_without_losing_its_changes(self):
        self.assert_merged_pr_transition("another-contributor", {1})

    def test_owned_merged_pr_stays_included_until_the_official_nightly_contains_it(self):
        self.assert_merged_pr_transition("NikitaMGrimm", set())

    def assert_merged_pr_transition(self, author, selected):
        first = self.pull(1, {"pr.txt": "accepted upstream fix\n"})
        first["author"] = author
        self.prepare([first])
        nightly.git("checkout", "upstream", cwd=self.repo)
        nightly.git("merge", "--no-ff", "pr-1", "-m", "Merge PR 1", cwd=self.repo)
        merge = self.head()
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        data = {"number": 1, "title": first["title"], "state": "closed", "merged": True,
                "merge_commit_sha": merge, "head": {"sha": first["headSha"], "ref": "pr-1"},
                "base": {"sha": first["baseSha"], "ref": "main"},
                "user": {"login": first["author"]}, "html_url": "https://github.com/pingdotgg/t3code/pull/1"}
        original_run = nightly.subprocess.run
        def github_or_git(args, **kwargs):
            if args[0] == "gh":
                return subprocess.CompletedProcess(args, 0, json.dumps(data), "")
            return original_run(args, **kwargs)
        with patch.object(nightly, "discover_pull_requests", return_value=[]), \
                patch.object(nightly.subprocess, "run", side_effect=github_or_git):
            waiting = nightly.discover_included_pull_requests(self.repo, self.manifest(), self.tag, selected)
            self.assertEqual([pull["number"] for pull in waiting], [1])
            self.prepare(waiting)
            self.assertEqual((self.repo / "pr.txt").read_text(), "accepted upstream fix\n")
            self.tag = "v0.0.46-nightly.20261012.2"
            nightly.git("tag", self.tag, merge, cwd=self.repo)
            landed = nightly.discover_included_pull_requests(self.repo, self.manifest(), self.tag, selected)
            self.assertEqual(landed, [])
            self.prepare(landed)
        self.assertEqual((self.repo / "pr.txt").read_text(), "accepted upstream fix\n")
        self.assertEqual(self.manifest()["pullRequests"], [])

    def test_selection_changes_persist_without_building_during_cooldown(self):
        self.remote()
        nightly.write_state(self.repo, "build-timing.json", {"completedAt": 100, "sequence": 1})
        head = self.head()
        status, fetch = self.run_prepare([], 200, manual=True,
            include="https://github.com/pingdotgg/t3code/pull/42, #43")
        self.assertEqual(status["phase"], "debouncing")
        fetch.assert_not_called()
        self.assertEqual(self.head(), head)
        self.assertEqual(nightly.read_state(self.repo, "included-prs.json")["numbers"], [42, 43])
        self.run_prepare([], 300, manual=True, remove="42")
        self.assertEqual(nightly.read_state(self.repo, "included-prs.json")["numbers"], [43])

    def test_other_contributors_main_branches_are_not_false_stack_dependencies(self):
        first = self.pull(1, {"first.txt": "first"})
        second = self.pull(2, {"second.txt": "second"})
        first.update(headRef="main", headRepository="someone/t3code", baseRepository="pingdotgg/t3code")
        second.update(headRepository="NikitaMGrimm/t3code", baseRepository="pingdotgg/t3code")
        self.assertEqual([pull["number"] for pull in nightly.ordered_pull_requests([first, second])], [1, 2])
        self.assertEqual(self.prepare([first, second])["phase"], "building")

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

    def test_candidate_snapshot_can_publish_after_pr_updates_but_not_direct_pushes(self):
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        first = self.pull(1, {"pr.txt": "old"})
        status = {"baseCommit": self.head(), "inputs": {"pullRequests": nightly.pull_request_inputs([first])}}
        self.assertTrue(nightly.candidate_is_current(self.repo, status, self.config))
        updated = self.pull(1, {"pr.txt": "new"})
        self.assertNotEqual(first["headSha"], updated["headSha"])
        self.assertTrue(nightly.candidate_is_current(self.repo, status, self.config))
        candidate = self.prepare([first])["candidateCommit"]
        status["candidateCommit"] = candidate
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        self.assertTrue(nightly.candidate_is_current(self.repo, status, self.config))
        (self.repo / "personal.txt").write_text("new direct fix")
        self.commit("new direct fix")
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        self.assertFalse(nightly.candidate_is_current(self.repo, status, self.config))

    def test_verify_reports_current_and_superseded_candidates_without_failing(self):
        self.remote()
        status = self.prepare([])
        status_path = Path(self.temp.name) / "personal-nightly-status.json"
        status_path.write_text(json.dumps(status))
        output = Path(self.temp.name) / "verify-output"
        args = ["personal-nightly", "verify"]
        env = {"RUNNER_TEMP": self.temp.name, "GITHUB_OUTPUT": str(output)}
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", args), \
                patch.dict(os.environ, env):
            nightly.main()
        self.assertEqual(output.read_text(), "phase=current\n")
        output.unlink()
        (self.repo / "personal.txt").write_text("a newer direct fix\n")
        latest = self.commit("new direct fix")
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", args), \
                patch.dict(os.environ, env):
            nightly.main()
        self.assertEqual(output.read_text(), "phase=superseded\n")
        self.assertEqual(json.loads(status_path.read_text()), status)
        self.assertIn(latest, nightly.git("ls-remote", "origin", "refs/heads/personal-nightly", cwd=self.repo).stdout)

    def test_verify_keeps_remote_errors_as_failures(self):
        self.remote()
        status_path = Path(self.temp.name) / "personal-nightly-status.json"
        status_path.write_text(json.dumps(self.prepare([])))
        output = Path(self.temp.name) / "verify-output"
        nightly.git("remote", "set-url", "origin", str(Path(self.temp.name) / "missing.git"), cwd=self.repo)
        with patch.object(Path, "cwd", return_value=self.repo), \
                patch.object(sys, "argv", ["personal-nightly", "verify"]), \
                patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name, "GITHUB_OUTPUT": str(output)}):
            with self.assertRaises(subprocess.CalledProcessError):
                nightly.main()
        self.assertFalse(output.exists())

    def test_verify_keeps_a_missing_integration_branch_as_a_failure(self):
        self.remote()
        status_path = Path(self.temp.name) / "personal-nightly-status.json"
        status_path.write_text(json.dumps(self.prepare([])))
        output = Path(self.temp.name) / "verify-output"
        nightly.git("push", "origin", ":refs/heads/personal-nightly", cwd=self.repo)
        with patch.object(Path, "cwd", return_value=self.repo), \
                patch.object(sys, "argv", ["personal-nightly", "verify"]), \
                patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name, "GITHUB_OUTPUT": str(output)}):
            with self.assertRaisesRegex(RuntimeError, "integration branch is missing"):
                nightly.main()
        self.assertFalse(output.exists())

    def test_superseded_status_keeps_the_published_release_and_retries_new_changes(self):
        self.remote()
        version = self.tag.removeprefix("v")
        nightly.write_status(self.repo, {"phase": "ready", "releasedVersion": version, "sequence": 1})
        status = self.prepare([])
        nightly.write_status(self.repo, status)
        status_path = Path(self.temp.name) / "personal-nightly-status.json"
        status_path.write_text(json.dumps(status))
        (self.repo / "personal.txt").write_text("a newer direct fix\n")
        self.commit("new direct fix")
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        args = ["personal-nightly", "status", "--phase", "superseded", "--ref", status["candidateCommit"]]
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", args), \
                patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name}), \
                patch.object(nightly.time, "time", return_value=300):
            nightly.main()
        saved = nightly.read_state(self.repo, "status.json")
        self.assertEqual(saved["phase"], "ready")
        self.assertEqual(saved["releasedVersion"], version)
        self.assertNotIn("candidateVersion", saved)
        self.assertNotIn("candidateCommit", saved)
        timing = nightly.read_state(self.repo, "build-timing.json")
        self.assertEqual(timing, {"completedAt": 300, "sequence": status["sequence"]})
        waiting, fetch = self.run_prepare([], 400)
        self.assertEqual(waiting["phase"], "debouncing")
        fetch.assert_not_called()
        retry, fetch = self.run_prepare([], 2100)
        self.assertEqual(retry["phase"], "building")
        fetch.assert_called_once()
        self.assertEqual((self.repo / "personal.txt").read_text(), "a newer direct fix\n")

    def test_superseded_first_build_does_not_advertise_an_unpublished_release(self):
        self.remote()
        status = self.prepare([])
        nightly.write_status(self.repo, status)
        (Path(self.temp.name) / "personal-nightly-status.json").write_text(json.dumps(status))
        args = ["personal-nightly", "status", "--phase", "superseded", "--ref", status["candidateCommit"]]
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", args), \
                patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name}):
            nightly.main()
        saved = nightly.read_state(self.repo, "status.json")
        self.assertEqual(saved["phase"], "building")
        self.assertIsNone(saved["releasedVersion"])
        self.assertNotIn("candidateVersion", saved)

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

    def test_a_reviewed_upstream_deletion_survives_a_pr_that_still_modifies_the_file(self):
        nightly.git("checkout", "upstream", cwd=self.repo)
        (self.repo / "old.test.txt").write_text("old test\n")
        self.commit("upstream adds a test")
        self.tag = "v0.0.46-nightly.20261013.2"
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        pull = self.pull(1, {"old.test.txt": "PR test\n", "pr.txt": "PR fix\n"})
        self.assertEqual(self.prepare([pull])["phase"], "building")
        nightly.git("checkout", "upstream", cwd=self.repo)
        nightly.git("rm", "old.test.txt", cwd=self.repo)
        self.commit("upstream moves the test")
        self.tag = "v0.0.46-nightly.20261014.3"
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        # The first time, deleting a file the PR modifies needs a person.
        self.assertEqual(self.prepare([pull])["conflicts"], ["old.test.txt"])
        nightly.git("rm", "old.test.txt", cwd=self.repo)
        self.commit("keep the upstream deletion")
        self.assertEqual(self.prepare([pull])["phase"], "building")
        self.assertFalse((self.repo / "old.test.txt").exists())
        self.assertEqual((self.repo / "pr.txt").read_text(), "PR fix\n")
        # A PR the last candidate did not include has not had that review.
        other = self.pull(2, {"old.test.txt": "other test\n"}, from_ref=self.tag + "~1")
        self.assertEqual(self.prepare([pull, other])["conflicts"], ["old.test.txt"])

    def test_only_the_owner_can_change_release_tooling_through_a_pr(self):
        def tooling_pull(files):
            for directory in (".github/workflows", "scripts"):
                (self.repo / directory).mkdir(parents=True, exist_ok=True)
            return self.pull(1, {**files, "app.txt": "feature\n"})

        tooling = {".github/workflows/ü.yml": "on: push\n", "scripts/personal-nightly.py": "pass\n"}
        other = dict(tooling_pull({**tooling, "personal-nightly.json": "{}\n"}), author="someone-else")
        before = self.head()
        status = self.prepare([other])
        self.assertEqual(status["phase"], "conflict")
        self.assertEqual(sorted(status["conflicts"]), sorted([*tooling, "personal-nightly.json"]))
        self.assertEqual(status["conflictPullRequest"], 1)
        self.assertEqual(self.head(), before)
        owned = dict(tooling_pull(tooling), author="nikitamgrimm")
        self.assertEqual(self.prepare([owned])["phase"], "building")
        self.assertEqual((self.repo / "scripts" / "personal-nightly.py").read_text(), "pass\n")

    def test_recording_a_resolution_retries_a_conflict_without_other_changes(self):
        self.remote()
        first = self.pull(1, {"shared.txt": "one\n"})
        second = self.pull(2, {"shared.txt": "two\n"})
        status, _ = self.run_prepare([first, second], 100, forced=True)
        self.assertEqual(status["phase"], "conflict")
        suppressed, fetch = self.run_prepare([first, second], 200)
        self.assertEqual(suppressed["phase"], "debouncing")
        fetch.assert_not_called()
        nightly.write_state(self.repo, "resolutions.json", {"0" * 40: {"preimage": "a", "postimage": "b"}})
        waiting, _ = self.run_prepare([first, second], 300)
        self.assertEqual(waiting["phase"], "debouncing")
        _, fetch = self.run_prepare([first, second], 420)
        fetch.assert_called_once()


class InputDiscoveryTests(unittest.TestCase):
    config = {"repository": "NikitaMGrimm/t3code", "upstreamRepository": "pingdotgg/t3code"}

    def node(self, number):
        return {"number": number, "title": f"Fix {number}", "state": "OPEN",
                "headRefOid": "a" * 40, "headRefName": f"pr-{number}",
                "baseRefOid": "b" * 40, "baseRefName": "main", "author": {"login": "NikitaMGrimm"}}

    def response(self, numbers, more=False, cursor=None):
        return subprocess.CompletedProcess([], 0, json.dumps({"data": {"search": {
            "issueCount": 2, "nodes": [self.node(number) for number in numbers],
            "pageInfo": {"hasNextPage": more, "endCursor": cursor}}}}), "")

    def rest_pull(self, number, state="open", head="a" * 40):
        return {"number": number, "title": f"Someone else's fix {number}", "state": state, "merged": False,
                "head": {"sha": head, "ref": "main", "repo": {"full_name": "someone/t3code"}},
                "base": {"sha": "b" * 40, "ref": "main", "repo": {"full_name": "pingdotgg/t3code"}},
                "user": {"login": "someone"}, "html_url": f"https://github.com/pingdotgg/t3code/pull/{number}"}

    def rest_response(self, pull):
        return subprocess.CompletedProcess([], 0, json.dumps(pull), "")

    def test_explicit_selection_includes_other_authors_and_deduplicates_own_prs(self):
        own = {"number": 1, "headSha": "c" * 40, "baseRef": "main", "author": "NikitaMGrimm"}
        with patch.object(nightly, "discover_pull_requests", return_value=[own]), \
                patch.object(nightly.subprocess, "run", return_value=self.rest_response(self.rest_pull(2))) as run:
            pulls = nightly.discover_included_pull_requests(Path("unused"), self.config, "tag", {1, 2})
        self.assertEqual([pull["number"] for pull in pulls], [1, 2])
        self.assertEqual(pulls[1]["author"], "someone")
        self.assertEqual(pulls[1]["url"], "https://github.com/pingdotgg/t3code/pull/2")
        run.assert_called_once()

    def test_selected_pr_follows_latest_heads_and_keeps_its_last_head_when_closed_unmerged(self):
        with patch.object(nightly, "discover_pull_requests", return_value=[]), \
                patch.object(nightly.subprocess, "run", side_effect=[
                    self.rest_response(self.rest_pull(2)),
                    self.rest_response(self.rest_pull(2, head="c" * 40)),
                    self.rest_response(self.rest_pull(2, state="closed", head="c" * 40)),
                ]):
            first = nightly.discover_included_pull_requests(Path("unused"), self.config, "tag", {2})
            updated = nightly.discover_included_pull_requests(Path("unused"), self.config, "tag", {2})
            closed = nightly.discover_included_pull_requests(Path("unused"), self.config, "tag", {2})
        self.assertNotEqual(nightly.pull_request_inputs(first), nightly.pull_request_inputs(updated))
        self.assertEqual(nightly.pull_request_inputs(updated), nightly.pull_request_inputs(closed))

    def test_owned_pr_closed_unmerged_leaves_unless_it_was_selected(self):
        config = {**self.config, "pullRequests": [{"number": 1, "author": "NikitaMGrimm"}]}
        closed = self.rest_response(self.rest_pull(1, state="closed"))
        with patch.object(nightly, "discover_pull_requests", return_value=[]), \
                patch.object(nightly.subprocess, "run", return_value=closed):
            automatic = nightly.discover_included_pull_requests(Path("unused"), config, "tag", set())
            kept = nightly.discover_included_pull_requests(Path("unused"), config, "tag", {1})
        self.assertEqual(automatic, [])
        self.assertEqual([pull["number"] for pull in kept], [1])

    def test_removing_a_selected_other_authors_pr_stops_tracking_it(self):
        config = {**self.config, "pullRequests": [{"number": 2, "author": "someone"}]}
        with patch.object(nightly, "discover_pull_requests", return_value=[]), \
                patch.object(nightly.subprocess, "run") as run:
            self.assertEqual(nightly.discover_included_pull_requests(Path("unused"), config, "tag", set()), [])
        run.assert_not_called()

    def test_unavailable_selected_pr_fails_discovery_instead_of_publishing_a_partial_set(self):
        with patch.object(nightly, "discover_pull_requests", return_value=[{"number": 1}]), \
                patch.object(nightly.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["gh"])), \
                self.assertRaises(subprocess.CalledProcessError):
            nightly.discover_included_pull_requests(Path("unused"), self.config, "tag", {2})

    def test_pr_link_input_supports_numbers_urls_and_multiple_links(self):
        value = "42, #43\nhttps://github.com/pingdotgg/t3code/pull/44#issuecomment-123 42"
        self.assertEqual(nightly.pull_request_numbers(value, "pingdotgg/t3code"), {42, 43, 44})
        for invalid in ["0", "-42", "https://github.com/another/repo/pull/42",
                        "https://github.com/pingdotgg/t3code/issues/42", "$(date)"]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                nightly.pull_request_numbers(invalid, "pingdotgg/t3code")

    def test_ambiguous_add_and_remove_cannot_change_the_selection(self):
        with patch.object(nightly, "read_state") as read, patch.object(nightly, "write_state") as write, \
                self.assertRaisesRegex(ValueError, "same request"):
            nightly.update_selected_pull_requests(Path("unused"), self.config, "42", "#42", 1)
        read.assert_not_called()
        write.assert_not_called()

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

    def test_cooldown_starts_at_completion_and_expires_without_sliding(self):
        self.assertFalse(nightly.build_is_cooling_down({}, 100))
        timing = {"completedAt": 500}
        self.assertTrue(nightly.build_is_cooling_down(timing, 500))
        self.assertTrue(nightly.build_is_cooling_down(timing, 2299))
        self.assertFalse(nightly.build_is_cooling_down(timing, 2300))


if __name__ == "__main__":
    unittest.main()
