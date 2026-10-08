import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("personal_nightly", Path(__file__).with_name("personal-nightly.py"))
nightly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nightly)


class NightlyIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        nightly.git("init", "-b", "personal-nightly", str(self.repo))
        nightly.git("config", "user.name", "test", cwd=self.repo)
        nightly.git("config", "user.email", "test@example.invalid", cwd=self.repo)
        self.tag = "v0.0.46-nightly.20261007.1"
        (self.repo / "personal-nightly.json").write_text(json.dumps({"repository": "NikitaMGrimm/t3code", "upstreamRepository": "pingdotgg/t3code", "upstreamTag": "v0.0.46-nightly.20261006.1"}))
        (self.repo / "shared.txt").write_text("base\n")
        self.commit("base")
        nightly.git("tag", "v0.0.46-nightly.20261006.1", cwd=self.repo)
        nightly.git("branch", "upstream", cwd=self.repo)
        (self.repo / "personal.txt").write_text("my fix\n")
        self.commit("personal fix")

    def commit(self, message):
        nightly.git("add", ".", cwd=self.repo)
        nightly.git("commit", "-m", message, cwd=self.repo)

    def upstream(self, shared):
        nightly.git("checkout", "upstream", cwd=self.repo)
        (self.repo / "shared.txt").write_text(shared)
        self.commit("official nightly")
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)

    def published_release(self, version="0.0.46-nightly.20261007.100"):
        return {"draft": False, "tag_name": f"v{version}",
                "target_commitish": nightly.git("rev-parse", "HEAD", cwd=self.repo).stdout.strip()}

    def official_release(self, tag=None, body=None):
        return {"draft": False, "tag_name": tag or self.tag,
                "body": body if body is not None else "## What's Changed\n* upstream feature by @author\n\n## New Contributors\n* first contribution\n\n**Full Changelog**: https://github.com/pingdotgg/t3code/compare/old...new"}

    def test_initial_notes_combine_official_changes_and_all_personal_commits(self):
        (self.repo / "import.txt").write_text("import")
        self.commit("fix(web): imported example (personal import #42)")
        self.upstream("upstream\n")
        nightly.prepare(self.repo, self.tag, "123")
        notes = nightly.release_notes(self.repo, "HEAD", "0.0.46-nightly.20261007.200", [], [self.official_release()])
        self.assertIn("upstream feature by @author", notes)
        self.assertIn("personal fix", notes)
        self.assertIn("fix(web): imported example", notes)
        self.assertIn("https://github.com/pingdotgg/t3code/pull/42", notes)
        self.assertIn("https://github.com/NikitaMGrimm/t3code/commit/", notes)
        self.assertNotIn("first contribution", notes)
        self.assertNotIn("chore: track", notes)
        self.assertNotIn("official nightly ([", notes)

    def test_notes_include_skipped_nightlies_and_a_normally_merged_fix_branch(self):
        self.upstream("first\n")
        nightly.prepare(self.repo, self.tag, "123")
        previous = self.published_release()
        nightly.git("checkout", "-b", "my-fix", cwd=self.repo)
        (self.repo / "new-fix.txt").write_text("fix")
        self.commit("fix(web): my new personal fix")
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        nightly.git("merge", "--no-ff", "my-fix", "-m", "Merge my-fix", cwd=self.repo)
        nightly.git("checkout", "upstream", cwd=self.repo)
        tags = ["v0.0.46-nightly.20261007.2", "v0.0.46-nightly.20261007.3"]
        for index, tag in enumerate(tags):
            (self.repo / "shared.txt").write_text(f"next {index}\n")
            self.commit(f"official update {index}")
            nightly.git("tag", tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        nightly.prepare(self.repo, tags[-1], "124")
        releases = [self.official_release(), self.official_release(tags[0], "- second upstream fix"),
                    self.official_release(tags[1], "- third upstream fix\n- second upstream fix")]
        notes = nightly.release_notes(self.repo, "HEAD", "0.0.46-nightly.20261007.200", [previous], releases)
        self.assertIn("second upstream fix", notes)
        self.assertIn("third upstream fix", notes)
        self.assertEqual(notes.count("- second upstream fix"), 1)
        self.assertEqual(notes.count("my new personal fix"), 1)
        self.assertNotIn("upstream feature", notes)
        self.assertNotIn("- personal fix", notes)
        self.assertNotIn("Merge my-fix", notes)
        self.assertNotIn("official update", notes)
        self.assertNotIn("chore: track", notes)

    def test_personal_only_update_does_not_repeat_unchanged_upstream_notes(self):
        self.upstream("first\n")
        nightly.prepare(self.repo, self.tag, "123")
        previous = self.published_release()
        (self.repo / "phone.txt").write_text("fix")
        self.commit("fix(server): restore the iPhone connection")
        notes = nightly.release_notes(self.repo, "HEAD", "0.0.46-nightly.20261007.200", [previous], [self.official_release()])
        self.assertIn("restore the iPhone connection", notes)
        self.assertIn(f"Unchanged from [{self.tag}]", notes)
        self.assertNotIn("upstream feature", notes)
        self.assertNotIn("- personal fix", notes)

    def test_upstream_only_update_keeps_the_summary_for_actual_changes(self):
        self.upstream("first\n")
        nightly.prepare(self.repo, self.tag, "123")
        previous = self.published_release()
        nightly.git("checkout", "upstream", cwd=self.repo)
        (self.repo / "shared.txt").write_text("next\n")
        self.commit("official next change")
        next_tag = "v0.0.46-nightly.20261007.2"
        nightly.git("tag", next_tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        nightly.prepare(self.repo, next_tag, "124")
        releases = [self.official_release(), self.official_release(next_tag, "- next upstream fix")]
        notes = nightly.release_notes(self.repo, "HEAD", "0.0.46-nightly.20261007.200", [previous], releases)
        self.assertIn("next upstream fix", notes)
        self.assertIn("## Personal changes (none)", notes)
        self.assertNotIn("- personal fix", notes)
        self.assertNotIn("No new personal commits", notes)

    def test_notes_use_the_latest_successful_earlier_release_not_drafts_or_evidence(self):
        self.upstream("first\n")
        nightly.prepare(self.repo, self.tag, "123")
        previous = self.published_release()
        (self.repo / "new.txt").write_text("new")
        self.commit("fix: the unreleased fix")
        current = self.published_release("0.0.46-nightly.20261007.200")
        draft = self.published_release("0.0.46-nightly.20261007.150")
        draft["draft"] = True
        evidence = dict(current, tag_name="pr-evidence-example")
        old = dict(previous, tag_name="v0.0.46-nightly.20261007.99")
        notes = nightly.release_notes(self.repo, "HEAD", "0.0.46-nightly.20261007.200",
                                      [evidence, old, current, draft, previous], [self.official_release()])
        self.assertIn("the unreleased fix", notes)
        self.assertNotIn("- personal fix", notes)

    def test_notes_command_accepts_paginated_official_metadata_and_an_exact_published_ref(self):
        self.upstream("first\n")
        nightly.prepare(self.repo, self.tag, "123")
        published = self.published_release("0.0.46-nightly.20261007.200")
        (self.repo / "later.txt").write_text("later")
        self.commit("fix: a later unreleased change")
        index = Path(self.temp.name) / "personal.json"
        official = Path(self.temp.name) / "official.json"
        output = Path(self.temp.name) / "notes.md"
        index.write_text(json.dumps([published]))
        official.write_text(json.dumps([[self.official_release()]]))
        arguments = ["personal-nightly", "notes", "--ref", published["target_commitish"],
                     "--version", "0.0.46-nightly.20261007.200", "--release-index", str(index),
                     "--upstream-release-index", str(official), "--notes-file", str(output)]
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", arguments):
            nightly.main()
        self.assertIn("personal fix", output.read_text())
        self.assertNotIn("a later unreleased change", output.read_text())

    def test_notes_fail_when_official_metadata_is_missing_or_empty(self):
        self.upstream("first\n")
        nightly.prepare(self.repo, self.tag, "123")
        for releases in [[], [self.official_release(body="")]]:
            with self.assertRaisesRegex(ValueError, "Missing official"):
                nightly.release_notes(self.repo, "HEAD", "0.0.46-nightly.20261007.200", [], releases)

    def test_clean_merge_preserves_personal_fixes_and_provenance(self):
        self.upstream("upstream\n")
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}), patch.object(nightly.time, "time_ns", return_value=12345000000):
            status = nightly.prepare(self.repo, self.tag, "123")
        self.assertEqual(status["phase"], "building")
        self.assertEqual(status["candidateVersion"], "0.0.46-nightly.20261007.12345")
        self.assertEqual((self.repo / "personal.txt").read_text(), "my fix\n")
        self.assertEqual((self.repo / "shared.txt").read_text(), "upstream\n")
        self.assertEqual(json.loads((self.repo / "personal-nightly.json").read_text())["upstreamTag"], self.tag)

    def test_conflict_aborts_without_altering_the_working_release(self):
        (self.repo / "shared.txt").write_text("personal\n")
        self.commit("personal shared fix")
        base = nightly.git("rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        self.upstream("upstream\n")
        status = nightly.prepare(self.repo, self.tag, "123")
        self.assertEqual(status["phase"], "conflict")
        self.assertEqual(status["conflicts"], ["shared.txt"])
        self.assertEqual(nightly.git("rev-parse", "HEAD", cwd=self.repo).stdout.strip(), base)
        self.assertEqual((self.repo / "shared.txt").read_text(), "personal\n")
        self.assertEqual(nightly.git("status", "--porcelain", cwd=self.repo).stdout, "")

    def test_failed_build_status_keeps_the_previous_downloadable_version(self):
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        nightly.write_status(self.repo, {"phase": "ready", "releasedVersion": "working", "conflicts": []})
        nightly.write_status(self.repo, {"phase": "failed", "releasedVersion": None, "conflicts": []})
        nightly.git("fetch", "origin", "personal-update-status", cwd=self.repo)
        status = json.loads(nightly.git("show", "FETCH_HEAD:status.json", cwd=self.repo).stdout)
        self.assertEqual(status["releasedVersion"], "working")
        self.assertEqual(status["phase"], "failed")
        self.assertEqual(nightly.git("status", "--porcelain", cwd=self.repo).stdout, "")

    def test_stale_result_cannot_replace_a_newer_success(self):
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        latest = {"phase": "ready", "releasedVersion": "new", "conflicts": [], "sequence": 200}
        nightly.write_status(self.repo, latest)
        nightly.write_status(self.repo, {"phase": "failed", "releasedVersion": None, "sequence": 100})
        nightly.write_status(self.repo, {"phase": "ready", "releasedVersion": "old", "sequence": 100})
        nightly.git("fetch", "origin", "personal-update-status", cwd=self.repo)
        self.assertEqual(json.loads(nightly.git("show", "FETCH_HEAD:status.json", cwd=self.repo).stdout), latest)

    def test_old_workflow_rerun_gets_a_newer_version(self):
        self.upstream("upstream\n")
        with patch.object(nightly.time, "time_ns", return_value=200000000):
            first = nightly.prepare(self.repo, self.tag, "200")
        with patch.object(nightly.time, "time_ns", return_value=300000000):
            rerun = nightly.prepare(self.repo, self.tag, "100")
        self.assertGreater(int(rerun["candidateVersion"].split(".")[-1]), int(first["candidateVersion"].split(".")[-1]))

    def test_unchanged_published_head_does_not_rebuild(self):
        self.upstream("upstream\n")
        nightly.prepare(self.repo, self.tag, "123")
        head = nightly.git("rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        releases = [{"draft": False, "tag_name": self.tag, "target_commitish": head}]
        status = nightly.prepare(self.repo, self.tag, "124", releases)
        self.assertTrue(status["skipBuild"])
        self.assertEqual(status["phase"], "ready")
        self.assertEqual(status["releasedVersion"], self.tag.removeprefix("v"))

    def test_missing_artifact_uses_the_saved_attempt_sequence(self):
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        latest = {"phase": "ready", "releasedVersion": "new", "sequence": 200}
        nightly.write_status(self.repo, latest)
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", ["personal-nightly", "status", "--phase", "failed"]), patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name, "GITHUB_RUN_ID": "123", "PERSONAL_NIGHTLY_SEQUENCE": "100"}):
            nightly.main()
        nightly.git("fetch", "origin", "personal-update-status", cwd=self.repo)
        self.assertEqual(json.loads(nightly.git("show", "FETCH_HEAD:status.json", cwd=self.repo).stdout), latest)

    def test_unchanged_run_repairs_a_failed_status_without_candidate_push(self):
        self.upstream("upstream\n")
        nightly.prepare(self.repo, self.tag, "123")
        head = nightly.git("rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        nightly.write_status(self.repo, {"phase": "failed", "releasedVersion": None, "sequence": 100})
        index = Path(self.temp.name) / "releases.json"
        index.write_text(json.dumps([{"draft": False, "tag_name": self.tag, "target_commitish": head}]))
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", ["personal-nightly", "prepare", "--tag", self.tag, "--release-index", str(index)]), patch.dict(os.environ, {"RUNNER_TEMP": self.temp.name, "GITHUB_RUN_ID": "123", "PERSONAL_NIGHTLY_SEQUENCE": "200"}):
            nightly.main()
        nightly.git("fetch", "origin", "personal-update-status", cwd=self.repo)
        status = json.loads(nightly.git("show", "FETCH_HEAD:status.json", cwd=self.repo).stdout)
        self.assertEqual(status["phase"], "ready")
        self.assertEqual(status["releasedVersion"], self.tag.removeprefix("v"))
        self.assertNotIn("candidate", nightly.git("ls-remote", "origin", cwd=self.repo).stdout)


if __name__ == "__main__":
    unittest.main()
