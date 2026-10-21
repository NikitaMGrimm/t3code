import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("personal_nightly_lockfile", Path(__file__).with_name("personal-nightly.py"))
nightly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nightly)

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_MANAGER = json.loads((ROOT / "package.json").read_text())["packageManager"]


def pinned_pnpm_available():
    try:
        result = subprocess.run(["pnpm", "--version"], cwd=ROOT, capture_output=True, text=True)
    except FileNotFoundError:
        return False
    return result.returncode == 0 and result.stdout.strip().splitlines()[-1:] == [PACKAGE_MANAGER.removeprefix("pnpm@").split("+")[0]]


def tarball(name, version):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz", format=tarfile.USTAR_FORMAT) as archive:
        for path, text in {"package/package.json": json.dumps({"name": name, "version": version, "main": "index.js"}),
                           "package/index.js": "one\ntwo\nthree\nfour\nfive\nsix\nseven\n"}.items():
            info = tarfile.TarInfo(path)
            info.size, info.mtime = len(text), 0
            archive.addfile(info, io.BytesIO(text.encode()))
    return data.getvalue()


BASE_PATCH = """diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,3 @@
-one
+ONE
 two
 three
"""
UPSTREAM_PATCH = BASE_PATCH.replace("+ONE\n", "+ONE!\n")
PR_PATCH = BASE_PATCH + """@@ -6,2 +6,2 @@
-six
+SIX
 seven
"""


class LockfileFixture(unittest.TestCase):
    """Real Git merges of real pnpm lockfiles: a patched dependency both sides change."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        nightly.git("init", "-b", "personal-nightly", str(self.repo))
        nightly.git("config", "user.name", "test", cwd=self.repo)
        nightly.git("config", "user.email", "test@example.invalid", cwd=self.repo)
        (self.repo / "vendor").mkdir()
        (self.repo / "vendor" / "dep-1.0.0.tgz").write_bytes(tarball("dep", "1.0.0"))
        (self.repo / "vendor" / "dep2-1.0.0.tgz").write_bytes(tarball("dep2", "1.0.0"))
        self.manifest({"dep": "file:vendor/dep-1.0.0.tgz"})
        (self.repo / "patches").mkdir()
        self.write({"patches/dep@1.0.0.patch": BASE_PATCH, "shared.txt": "base\n",
                    "pnpm-workspace.yaml": "patchedDependencies:\n  dep@1.0.0: patches/dep@1.0.0.patch\n"})
        self.lock()
        self.commit("official base")
        nightly.git("branch", "upstream", cwd=self.repo)
        self.config = {"repository": "NikitaMGrimm/t3code", "branch": "personal-nightly",
                       "upstreamRepository": "pingdotgg/t3code", "upstreamTag": "v0.0.46-nightly.20261011.1",
                       "prBaseline": self.head(), "pullRequests": []}
        self.write({"personal-nightly.json": json.dumps(self.config), "personal.txt": "my fix\n"})
        self.commit("personal overlay")
        self.tag = "v0.0.46-nightly.20261012.1"

    def head(self, ref="HEAD"):
        return nightly.git("rev-parse", ref, cwd=self.repo).stdout.strip()

    def write(self, files):
        for name, text in files.items():
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(text)

    def manifest(self, dependencies, package_manager=PACKAGE_MANAGER):
        self.write({"package.json": json.dumps({"name": "root", "private": True, "packageManager": package_manager,
                                                "dependencies": dependencies}, indent=2) + "\n"})

    def lock(self):
        subprocess.run(["pnpm", "install", "--lockfile-only", "--no-frozen-lockfile", "--ignore-scripts"],
                       cwd=self.repo, check=True, capture_output=True)

    def commit(self, message):
        nightly.git("add", ".", cwd=self.repo)
        nightly.git("commit", "-m", message, cwd=self.repo)
        return self.head()

    def official_nightly(self, files=None):
        nightly.git("checkout", "upstream", cwd=self.repo)
        self.write({"patches/dep@1.0.0.patch": UPSTREAM_PATCH, **(files or {})})
        self.lock()
        self.commit("official nightly")
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("checkout", "personal-nightly", cwd=self.repo)

    def pull(self, number, files=None, author="NikitaMGrimm", dependencies=None, package_manager=PACKAGE_MANAGER):
        base = self.head(f"{self.tag}^")
        nightly.git("checkout", "-B", f"pr-{number}", base, cwd=self.repo)
        self.write({"patches/dep@1.0.0.patch": PR_PATCH, **(files or {})})
        if dependencies:
            self.manifest({"dep": "file:vendor/dep-1.0.0.tgz", **dependencies})
        self.lock()
        if package_manager != PACKAGE_MANAGER:
            self.manifest({"dep": "file:vendor/dep-1.0.0.tgz", **(dependencies or {})}, package_manager)
        head = self.commit(f"PR {number}")
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        return {"number": number, "title": f"Fix {number}", "headSha": head, "baseSha": base,
                "baseRef": "main", "headRef": f"pr-{number}", "author": author,
                "headRepository": "pingdotgg/t3code", "baseRepository": "pingdotgg/t3code"}

    def prepare(self, pulls):
        return nightly.prepare(self.repo, self.tag, "123", (), pulls, {})


@unittest.skipUnless(pinned_pnpm_available(), f"needs {PACKAGE_MANAGER} on PATH, as CI's setup-vp provides")
class LockfileReconciliationTests(LockfileFixture):
    def test_combined_patch_gets_a_new_hash_and_keeps_the_prs_new_dependency(self):
        self.official_nightly()
        upstream_lock = nightly.git("show", f"{self.tag}:pnpm-lock.yaml", cwd=self.repo).stdout
        pull = self.pull(1, dependencies={"dep2": "file:vendor/dep2-1.0.0.tgz"})
        status = self.prepare([pull])
        self.assertEqual(status["phase"], "building")
        self.assertEqual(status["lockfileReconciliations"], [{"conflictStage": "pull_request", "pullRequest": 1}])
        merged_patch = (self.repo / "patches/dep@1.0.0.patch").read_text()
        self.assertIn("+ONE!", merged_patch)
        self.assertIn("+SIX", merged_patch)
        combined = hashlib.sha256(merged_patch.encode()).hexdigest()
        lock = (self.repo / "pnpm-lock.yaml").read_text()
        self.assertIn(f"dep@1.0.0: {combined}", lock)
        self.assertIn("dep2@file:vendor/dep2-1.0.0.tgz", lock)
        changed = [line for line in lock.splitlines() if line not in upstream_lock.splitlines()]
        self.assertTrue(changed)
        self.assertTrue(all(combined in line or "dep2" in line or line.strip() in ("", "version: 1.0.0", "dep2:")
                            or "resolution:" in line for line in changed), changed)
        frozen = subprocess.run(["pnpm", "install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"],
                                cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(frozen.returncode, 0, frozen.stdout + frozen.stderr)

    def test_lockfile_stays_conflicted_beside_a_source_conflict(self):
        self.official_nightly({"shared.txt": "upstream\n"})
        pull = self.pull(1, {"shared.txt": "pr\n"})
        head = self.head()
        status = self.prepare([pull])
        self.assertEqual(status["phase"], "conflict")
        self.assertEqual(status["conflicts"], ["pnpm-lock.yaml", "shared.txt"])
        self.assertEqual(status["conflictStage"], "pull_request")
        self.assertEqual(status["conflictPullRequest"], 1)
        self.assertEqual(status["lockfileReconciliation"]["reason"], "Other files also conflict")
        self.assertEqual(self.head(), head)
        self.assertEqual(self.prepare([pull])["conflictIdentity"], status["conflictIdentity"])

    def test_another_authors_package_manager_configuration_is_never_run(self):
        self.official_nightly()
        workspace = "patchedDependencies:\n  dep@1.0.0: patches/dep@1.0.0.patch\nsavePrefix: ''\n"
        pull = self.pull(1, {"pnpm-workspace.yaml": workspace}, author="someone-else")
        status = self.prepare([pull])
        self.assertEqual(status["conflicts"], ["pnpm-lock.yaml"])
        self.assertIn("PR #1 by another author", status["lockfileReconciliation"]["reason"])

    def test_a_refused_reconciliation_leaves_the_conflict_for_repair(self):
        self.official_nightly()
        nightly.git("checkout", "-B", "pr-1", f"{self.tag}^", cwd=self.repo)
        self.write({"patches/dep@1.0.0.patch": PR_PATCH})
        self.lock()
        # A lockfile change pnpm does not reproduce from the merged configuration.
        lock = (self.repo / "pnpm-lock.yaml").read_text()
        self.write({"pnpm-lock.yaml": lock.replace("autoInstallPeers: true", "autoInstallPeers: false")})
        pull = {"number": 1, "title": "Fix 1", "headSha": self.commit("PR 1"), "baseSha": self.head(f"{self.tag}^"),
                "baseRef": "main", "headRef": "pr-1", "author": "NikitaMGrimm",
                "headRepository": "pingdotgg/t3code", "baseRepository": "pingdotgg/t3code"}
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        status = self.prepare([pull])
        self.assertEqual(status["lockfileReconciliation"]["reason"], "Regeneration changes settings/autoInstallPeers")
        status.update(inputs={"pullRequests": nightly.pull_request_inputs([pull])}, pullRequests=[pull],
                      runUrl="https://github.com/NikitaMGrimm/t3code/actions/runs/123")
        keep = Path(self.temp.name) / "repair"
        repaired = nightly.reproduce(self.repo, status, {}, keep)
        self.assertEqual(repaired["conflictIdentity"], status["conflictIdentity"])
        self.assertIn("<<<<<<<", (keep / "pnpm-lock.yaml").read_text())

    def test_a_package_manager_other_than_the_official_pin_is_refused(self):
        self.official_nightly()
        pull = self.pull(1, package_manager="pnpm@10.0.0")
        status = self.prepare([pull])
        self.assertEqual(status["conflicts"], ["pnpm-lock.yaml"])
        self.assertIn("does not pin", status["lockfileReconciliation"]["reason"])

    def test_registry_failures_fail_the_run_instead_of_recording_a_conflict(self):
        self.official_nightly()
        pull = self.pull(1)
        fake = Path(self.temp.name) / "bin"
        fake.mkdir()
        version = PACKAGE_MANAGER.removeprefix("pnpm@").split("+")[0]
        (fake / "pnpm").write_text(f"#!/bin/sh\nif [ \"$1\" = --version ]; then echo {version}; exit 0; fi\n"
                                   "echo 'ERR_PNPM_META_FETCH_FAIL getaddrinfo EAI_AGAIN registry.npmjs.org' >&2\nexit 1\n")
        (fake / "pnpm").chmod(0o755)
        head = self.head()
        with patch.dict(os.environ, {"PATH": f"{fake}{os.pathsep}{os.environ['PATH']}"}):
            with self.assertRaisesRegex(RuntimeError, "could not reach the registry"):
                self.prepare([pull])
        self.assertEqual(self.head(), head)
        self.assertEqual(self.prepare([pull])["phase"], "building")

    def test_regeneration_must_equal_a_three_way_merge_of_both_lockfiles(self):
        base = (self.repo / "pnpm-lock.yaml").read_text()
        self.write({"patches/dep@1.0.0.patch": UPSTREAM_PATCH})
        self.lock()
        ours = (self.repo / "pnpm-lock.yaml").read_text()
        self.manifest({"dep": "file:vendor/dep-1.0.0.tgz", "dep2": "file:vendor/dep2-1.0.0.tgz"})
        self.lock()
        theirs_and_ours = (self.repo / "pnpm-lock.yaml").read_text()
        (self.repo / "vendor" / "dep2-1.0.1.tgz").write_bytes(tarball("dep2", "1.0.1"))
        self.manifest({"dep": "file:vendor/dep-1.0.0.tgz", "dep2": "file:vendor/dep2-1.0.1.tgz"})
        self.lock()
        other_version = (self.repo / "pnpm-lock.yaml").read_text()
        self.assertIsNone(nightly.unexpected_lockfile_change(base, ours, theirs_and_ours, theirs_and_ours))
        # The PR's added dependency is dropped.
        self.assertRegex(nightly.unexpected_lockfile_change(base, ours, theirs_and_ours, ours), "^Regeneration changes .*dep2")
        # A version neither side resolved.
        self.assertRegex(nightly.unexpected_lockfile_change(base, ours, theirs_and_ours, other_version), "^Regeneration changes")
        # Both sides resolve the same dependency differently.
        self.assertRegex(nightly.unexpected_lockfile_change(base, theirs_and_ours, other_version, other_version), "^Both sides change")


@unittest.skipUnless(pinned_pnpm_available(), f"needs {PACKAGE_MANAGER} on PATH, as CI's setup-vp provides")
class LockfileRetryTests(LockfileFixture):
    def run_main(self, args, now, env=None):
        environment = {"RUNNER_TEMP": self.temp.name, "GITHUB_EVENT_NAME": "schedule", "GITHUB_RUN_ID": "123",
                       "PERSONAL_NIGHTLY_SEQUENCE": str(now), "PERSONAL_NIGHTLY_FORCE": "false",
                       "PERSONAL_NIGHTLY_STABLE_INPUTS": "", **(env or {})}
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", ["personal-nightly", *args]), \
                patch.dict(os.environ, environment), patch.object(nightly.time, "time", return_value=now), \
                patch.object(nightly, "discover_included_pull_requests", return_value=self.pulls), \
                patch.object(nightly, "fetch_pull_requests"):
            nightly.main()

    def test_a_failed_reconciliation_run_is_retried_with_unchanged_inputs(self):
        self.official_nightly()
        self.pulls = [self.pull(1)]
        remote = Path(self.temp.name) / "remote.git"
        nightly.git("init", "--bare", str(remote))
        nightly.git("remote", "add", "origin", str(remote), cwd=self.repo)
        nightly.git("push", "origin", "HEAD:refs/heads/personal-nightly", cwd=self.repo)
        prepare = ["prepare", "--sync-prs", "--tag", self.tag]
        self.run_main(prepare, 0)  # first observation of these inputs only debounces
        fake = Path(self.temp.name) / "bin"
        fake.mkdir()
        (fake / "pnpm").write_text("#!/bin/sh\necho 'ECONNRESET' >&2\nexit 1\n")
        (fake / "pnpm").chmod(0o755)
        status_path = Path(self.temp.name) / "personal-nightly-status.json"
        status_path.unlink()
        with self.assertRaisesRegex(RuntimeError, "could not reach the registry"):
            self.run_main(prepare, 1000, {"PATH": f"{fake}{os.pathsep}{os.environ['PATH']}"})
        self.assertFalse(status_path.exists())
        # The workflow's status job records the failure from whatever prepare left behind.
        self.run_main(["status", "--phase", "failed", "--ref", ""], 1001)
        self.assertEqual(nightly.read_state(self.repo, "status.json")["phase"], "failed")
        self.run_main(prepare, 3000)
        status = json.loads(status_path.read_text())
        self.assertEqual(status["phase"], "building")
        self.assertEqual(status["lockfileReconciliations"], [{"conflictStage": "pull_request", "pullRequest": 1}])


class RepairCheckoutTests(unittest.TestCase):
    """A repair agent reproduces a recorded conflict, resolves it once, and exports the resolution."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        nightly.git("init", "-b", "personal-nightly", str(self.repo))
        nightly.git("config", "user.name", "test", cwd=self.repo)
        nightly.git("config", "user.email", "test@example.invalid", cwd=self.repo)
        (self.repo / "shared.txt").write_text("base\n")
        self.commit("official base")
        nightly.git("branch", "upstream", cwd=self.repo)
        config = {"repository": "NikitaMGrimm/t3code", "branch": "personal-nightly",
                  "upstreamRepository": "pingdotgg/t3code", "upstreamTag": "v0.0.46-nightly.20261011.1",
                  "prBaseline": self.head(), "pullRequests": []}
        (self.repo / "personal-nightly.json").write_text(json.dumps(config))
        (self.repo / "personal.txt").write_text("my fix\n")
        self.commit("personal overlay")
        self.tag = "v0.0.46-nightly.20261012.1"
        nightly.git("checkout", "upstream", cwd=self.repo)
        (self.repo / "shared.txt").write_text("upstream\n")
        self.commit("official nightly")
        nightly.git("tag", self.tag, cwd=self.repo)
        nightly.git("checkout", "-B", "pr-1", "upstream^", cwd=self.repo)
        (self.repo / "shared.txt").write_text("pr\n")
        head = self.commit("PR 1")
        nightly.git("checkout", "personal-nightly", cwd=self.repo)
        self.pulls = [{"number": 1, "title": "Fix 1", "headSha": head, "baseSha": self.head("upstream^"),
                       "baseRef": "main", "headRef": "pr-1", "author": "NikitaMGrimm",
                       "headRepository": "pingdotgg/t3code", "baseRepository": "pingdotgg/t3code"}]

    def head(self, ref="HEAD"):
        return nightly.git("rev-parse", ref, cwd=self.repo).stdout.strip()

    def commit(self, message):
        nightly.git("add", ".", cwd=self.repo)
        nightly.git("commit", "-m", message, cwd=self.repo)
        return self.head()

    def run_main(self, *args):
        output = io.StringIO()
        with patch.object(Path, "cwd", return_value=self.repo), patch.object(sys, "argv", ["personal-nightly", *args]), \
                patch.object(sys, "stdout", output):
            nightly.main()
        return json.loads(output.getvalue())

    def test_reproduce_keeps_the_conflict_and_record_lets_the_next_replay_pass_it(self):
        status = nightly.prepare(self.repo, self.tag, "123", (), self.pulls, {})
        status.update(inputs={"upstreamTag": self.tag, "pullRequests": nightly.pull_request_inputs(self.pulls),
                              "resolutions": nightly.resolutions_fingerprint({})},
                      pullRequests=self.pulls, runUrl="https://github.com/NikitaMGrimm/t3code/actions/runs/123")
        status_file = Path(self.temp.name) / "status.json"
        status_file.write_text(json.dumps(status))
        resolutions = Path(self.temp.name) / "resolutions.json"
        resolutions.write_text("{}")
        branch = self.head("personal-nightly")
        keep = Path(self.temp.name) / "repair"
        result = self.run_main("reproduce", "--status", str(status_file), "--resolutions", str(resolutions), "--keep", str(keep))
        self.assertEqual(result["conflicts"], ["shared.txt"])
        self.assertEqual((result["conflictStage"], result["conflictPullRequest"]), ("pull_request", 1))
        self.assertEqual(result["conflictIdentity"], status["conflictIdentity"])
        self.assertTrue(result["resolutionsMatchStatus"])
        self.assertIn("<<<<<<<", (keep / "shared.txt").read_text())

        (keep / "shared.txt").write_text("upstream and pr\n")
        nightly.git("add", "shared.txt", cwd=keep)
        nightly.git("rerere", cwd=keep)
        recorded = Path(self.temp.name) / "recorded.json"
        exported = self.run_main("record", "--resolutions", str(resolutions), "--keep", str(keep), "--output", str(recorded))
        self.assertEqual(len(exported["added"]), 1)

        replay = self.run_main("reproduce", "--status", str(status_file), "--resolutions", str(recorded),
                               "--keep", str(Path(self.temp.name) / "replay"))
        self.assertEqual(replay["conflicts"], [])
        self.assertFalse(replay["resolutionsMatchStatus"])
        candidate = replay["candidateCommit"]
        self.assertEqual(nightly.git("show", f"{candidate}:shared.txt", cwd=Path(replay["directory"])).stdout, "upstream and pr\n")
        self.assertEqual(self.head("personal-nightly"), branch)
        self.assertFalse(nightly.git("status", "--porcelain", cwd=self.repo).stdout)

        status["inputs"]["resolutions"] = exported["resolutions"]
        self.assertEqual(nightly.prepare(self.repo, self.tag, "124", (), self.pulls,
                                         json.loads(recorded.read_text()))["phase"], "building")


if __name__ == "__main__":
    unittest.main()
