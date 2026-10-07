#!/usr/bin/env python3
"""Prepare a nightly merge without advancing the last working personal branch."""

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path


def git(*args, cwd=None, check=True, input=None):
    return subprocess.run(["git", *args], cwd=cwd, check=check, input=input, text=True, capture_output=True)


def merge_nightly(repo, tag):
    result = git("merge", "--no-edit", tag, cwd=repo, check=False)
    if result.returncode == 0:
        return []
    conflicts = git("diff", "--name-only", "--diff-filter=U", cwd=repo).stdout.splitlines()
    git("merge", "--abort", cwd=repo, check=False)
    if not conflicts:
        raise RuntimeError("The nightly merge failed without file conflicts: " + result.stderr)
    return conflicts


def write_status(repo, status):
    """Use a separate data branch so failed candidates never enter the updater feed."""
    with tempfile.TemporaryDirectory(prefix="t3-nightly-status-") as directory:
        checkout = Path(directory) / "checkout"
        git("config", "user.name", "personal-nightly", cwd=repo)
        git("config", "user.email", "personal-nightly@users.noreply.github.com", cwd=repo)
        fetched = git("fetch", "origin", "personal-update-status", cwd=repo, check=False)
        previous = {}
        if fetched.returncode == 0:
            ref = "FETCH_HEAD"
        else:
            # Only a genuinely absent ref permits creation. Transport/auth failures must fail.
            refs = git("ls-remote", "origin", "refs/heads/personal-update-status", cwd=repo)
            if refs.stdout.strip():
                raise RuntimeError("Could not fetch the existing update status branch")
            empty_tree = git("mktree", cwd=repo, input="").stdout.strip()
            ref = git("commit-tree", empty_tree, "-m", "chore: initialize personal update status", cwd=repo).stdout.strip()
        # Worktrees share checkout's scoped Actions credentials; independent clones do not.
        git("worktree", "add", "--detach", str(checkout), ref, cwd=repo)
        if (checkout / "status.json").exists():
            previous = json.loads((checkout / "status.json").read_text())
        if status.get("sequence", 0) < previous.get("sequence", 0):
            git("worktree", "remove", str(checkout), cwd=repo)
            return
        if status["phase"] != "ready":
            status["releasedVersion"] = previous.get("releasedVersion")
        (checkout / "status.json").write_text(json.dumps(status, indent=2) + "\n")
        git("add", "status.json", cwd=checkout)
        if git("diff", "--cached", "--quiet", cwd=checkout, check=False).returncode:
            git("commit", "-m", "chore: record personal nightly update status", cwd=checkout)
        git("push", "origin", "HEAD:refs/heads/personal-update-status", cwd=checkout)
        git("worktree", "remove", str(checkout), cwd=repo)


def prepare(repo, tag, run_number, published_releases=()):
    match = re.fullmatch(r"v(\d+\.\d+\.\d+-nightly\.\d{8})\.\d+", tag)
    if match is None:
        raise ValueError("Only an exact official nightly tag can be synchronized")
    config_path = Path(repo) / "personal-nightly.json"
    config = json.loads(config_path.read_text())
    # Keep the shared workflow job identity stable across fresh checkouts.
    git("config", "user.name", "personal-nightly", cwd=repo)
    git("config", "user.email", "personal-nightly@users.noreply.github.com", cwd=repo)
    base = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
    sequence = int(os.environ.get("PERSONAL_NIGHTLY_SEQUENCE") or time.time_ns() // 1_000_000)
    published = next((release for release in published_releases if
        release.get("draft") is False and release.get("target_commitish") == base
        and re.fullmatch(r"v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+", release.get("tag_name", ""))
    ), None)
    if config["upstreamTag"] == tag and published is not None:
        return {"schema": 1, "phase": "ready", "skipBuild": True, "upstreamTag": tag,
                "conflicts": [], "releasedVersion": published["tag_name"].removeprefix("v"),
                "sequence": sequence, "candidateCommit": base,
                "runUrl": f"https://github.com/{config['repository']}/actions/runs/{os.environ.get('GITHUB_RUN_ID', run_number)}"}
    if config["upstreamTag"] == tag:
        # Dispatch also builds newly added personal fixes against the same nightly.
        conflicts = []
    else:
        conflicts = merge_nightly(repo, tag)
    status = {
        "schema": 1,
        "phase": "conflict" if conflicts else "building",
        "upstreamTag": tag,
        "conflicts": conflicts,
        "runUrl": f"https://github.com/{config['repository']}/actions/runs/{os.environ.get('GITHUB_RUN_ID', run_number)}",
        "releasedVersion": None,
        "baseCommit": base,
        "sequence": sequence,
    }
    if conflicts:
        return status
    config["upstreamTag"] = tag
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    git("add", "personal-nightly.json", cwd=repo)
    if git("diff", "--cached", "--quiet", cwd=repo, check=False).returncode:
        git("commit", "-m", f"chore: track {tag}", cwd=repo)
    status["candidateCommit"] = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
    attempt = int(os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
    if not 1 <= attempt < 100:
        raise ValueError("Nightly run attempt must be between 1 and 99")
    # Rerunning an old workflow is a new build, so its version must advance.
    status["candidateVersion"] = f"{match[1]}.{status['sequence']}"
    return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "status"])
    parser.add_argument("--tag")
    parser.add_argument("--run-number", default=os.environ.get("GITHUB_RUN_ID"))
    parser.add_argument("--phase", choices=["ready", "failed", "conflict"])
    parser.add_argument("--release-index", type=Path)
    args = parser.parse_args()
    repo = Path.cwd()
    status_path = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "personal-nightly-status.json"
    if args.command == "prepare":
        releases = json.loads(args.release_index.read_text()) if args.release_index else []
        status = prepare(repo, args.tag, args.run_number, releases)
        status_path.write_text(json.dumps(status))
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with open(output, "a") as stream:
                stream.write(f"phase={'unchanged' if status.get('skipBuild') else status['phase']}\n")
                stream.write(f"ref={status.get('candidateCommit', '')}\n")
                stream.write(f"version={status.get('candidateVersion', '')}\n")
        if status.get("skipBuild"):
            write_status(repo, status)
            return
        if status["phase"] == "conflict":
            write_status(repo, status)
        else:
            candidate_branch = f"personal-nightly-candidate-{args.run_number}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}"
            git("push", "origin", f"HEAD:refs/heads/{candidate_branch}")
            write_status(repo, status)
    else:
        if status_path.exists():
            status = json.loads(status_path.read_text())
        else:
            config = json.loads((repo / "personal-nightly.json").read_text())
            status = {"schema": 1, "upstreamTag": config["upstreamTag"], "conflicts": [], "releasedVersion": None, "sequence": int(os.environ["PERSONAL_NIGHTLY_SEQUENCE"]), "runUrl": f"https://github.com/{config['repository']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"}
        status["phase"] = args.phase
        if args.phase == "ready":
            status["releasedVersion"] = status["candidateVersion"]
        write_status(repo, status)


if __name__ == "__main__":
    main()
