#!/usr/bin/env python3
"""Prepare a nightly merge without advancing the last working personal branch."""

import argparse
import hashlib
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
    write_state(repo, "status.json", status)


def write_state(repo, name, state):
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
        if (checkout / name).exists():
            previous = json.loads((checkout / name).read_text())
        if (state.get("sequence", 0) < previous.get("sequence", 0)
                or (name == "build-timing.json" and state.get("sequence") == previous.get("sequence"))):
            git("worktree", "remove", str(checkout), cwd=repo)
            return
        if name == "status.json" and state["phase"] != "ready":
            state["releasedVersion"] = previous.get("releasedVersion")
        (checkout / name).write_text(json.dumps(state, indent=2) + "\n")
        git("add", name, cwd=checkout)
        if git("diff", "--cached", "--quiet", cwd=checkout, check=False).returncode:
            git("commit", "-m", "chore: record personal nightly update status", cwd=checkout)
        git("push", "origin", "HEAD:refs/heads/personal-update-status", cwd=checkout)
        git("worktree", "remove", str(checkout), cwd=repo)


def read_state(repo, name):
    fetched = git("fetch", "origin", "personal-update-status", cwd=repo, check=False)
    if fetched.returncode:
        if git("ls-remote", "origin", "refs/heads/personal-update-status", cwd=repo).stdout.strip():
            raise RuntimeError("Could not fetch the existing update status branch")
        return {}
    files = git("ls-tree", "--name-only", "FETCH_HEAD", "--", name, cwd=repo).stdout.splitlines()
    return json.loads(git("show", f"FETCH_HEAD:{name}", cwd=repo).stdout) if files else {}


def pull_request_numbers(value, repository):
    numbers = set()
    for item in re.split(r"[\s,]+", value.strip()):
        if not item:
            continue
        match = re.fullmatch(r"#?([1-9]\d*)", item)
        if match is None:
            link = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/pull/([1-9]\d*)/?(?:[?#].*)?", item)
            if link is None or link[1].casefold() != repository.casefold():
                raise ValueError(f"Use PR numbers or links from {repository}: {item}")
            numbers.add(int(link[2]))
        else:
            numbers.add(int(match[1]))
    return numbers


def update_selected_pull_requests(repo, config, include, remove, sequence):
    additions = pull_request_numbers(include, config["upstreamRepository"])
    removals = pull_request_numbers(remove, config["upstreamRepository"])
    if additions & removals:
        raise ValueError("A PR cannot be included and removed in the same request")
    selected = read_state(repo, "included-prs.json")
    current = set(selected.get("numbers", []))
    updated = (current | additions) - removals
    if updated != current:
        # Selection is independent of candidates: a conflict must not discard the
        # user's request to follow this PR when its owner next pushes a fix.
        write_state(repo, "included-prs.json", {"numbers": sorted(updated), "sequence": sequence})
    return updated


def discover_pull_requests(config):
    """Search by author, including drafts, and paginate without the CLI's default limit."""
    author = config["repository"].split("/")[0]
    query = """query($searchQuery: String!, $cursor: String) {
      search(query: $searchQuery, type: ISSUE, first: 100, after: $cursor) {
        issueCount pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest {
          number title state headRefOid headRefName baseRefOid baseRefName author { login }
          headRepository { nameWithOwner } baseRepository { nameWithOwner }
        } }
      }
    }"""
    cursor = None
    pulls = []
    expected_count = None
    while True:
        args = ["gh", "api", "graphql", "-f", f"query={query}", "-f",
                f"searchQuery=repo:{config['upstreamRepository']} is:pr is:open author:{author}"]
        if cursor is not None:
            args += ["-f", f"cursor={cursor}"]
        response = json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)
        if response.get("errors"):
            raise RuntimeError("GitHub could not return the complete PR input set")
        search = response["data"]["search"]
        if search["issueCount"] > 1000:
            raise RuntimeError("The PR input set exceeds GitHub's search limit")
        if expected_count is None:
            expected_count = search["issueCount"]
        elif expected_count != search["issueCount"]:
            raise RuntimeError("The PR input set changed during pagination; retry discovery")
        for pull in search["nodes"]:
            if pull["author"]["login"].casefold() != author.casefold() or pull["state"] != "OPEN":
                raise RuntimeError("GitHub returned a PR outside the configured author's open set")
            if not all(re.fullmatch(r"[0-9a-f]{40}", pull[key]) for key in ("headRefOid", "baseRefOid")):
                raise ValueError("PR inputs require exact commit IDs")
            pulls.append({"number": pull["number"], "title": pull["title"],
                          "headSha": pull["headRefOid"], "baseSha": pull["baseRefOid"],
                          "headRef": pull["headRefName"], "baseRef": pull["baseRefName"],
                          "author": pull["author"]["login"],
                          "url": f"https://github.com/{config['upstreamRepository']}/pull/{pull['number']}",
                          "headRepository": (pull.get("headRepository") or {}).get("nameWithOwner"),
                          "baseRepository": (pull.get("baseRepository") or {}).get("nameWithOwner")})
        if not search["pageInfo"]["hasNextPage"]:
            break
        next_cursor = search["pageInfo"]["endCursor"]
        if not next_cursor or next_cursor == cursor:
            raise RuntimeError("GitHub did not advance PR pagination")
        cursor = next_cursor
    if len(pulls) != expected_count or len({pull["number"] for pull in pulls}) != len(pulls):
        raise RuntimeError("The PR input set changed during pagination; retry discovery")
    return sorted(pulls, key=lambda pull: pull["number"])


def discover_included_pull_requests(repo, config, tag, selected):
    pulls = {pull["number"]: pull for pull in discover_pull_requests(config)}
    owner = config["repository"].split("/")[0].casefold()
    # Previously included authored PRs may have merged ahead of the official
    # nightly. Keep their patches until the nightly actually contains the merge.
    previous_owned = {pull["number"] for pull in config.get("pullRequests", [])
                      if pull.get("author", owner).casefold() == owner}
    for number in sorted((set(selected) | previous_owned) - pulls.keys()):
        response = subprocess.run(["gh", "api", f"repos/{config['upstreamRepository']}/pulls/{number}"],
                                  check=True, capture_output=True, text=True)
        pull = json.loads(response.stdout)
        if pull["state"] == "closed" and not pull["merged"]:
            # Selecting a PR is the choice to keep it: its last head stays included
            # after upstream declines it. Unselected owned PRs leave when closed.
            if number not in selected:
                continue
        elif pull["state"] == "closed":
            merge = pull["merge_commit_sha"]
            if not isinstance(merge, str) or re.fullmatch(r"[0-9a-f]{40}", merge) is None:
                raise ValueError(f"Merged PR #{number} requires an exact merge commit")
            if git("cat-file", "-e", f"{merge}^{{commit}}", cwd=repo, check=False).returncode:
                git("fetch", f"https://github.com/{config['upstreamRepository']}.git", merge, cwd=repo)
            included = git("merge-base", "--is-ancestor", merge, tag, cwd=repo, check=False)
            if included.returncode == 0:
                continue
            if included.returncode != 1:
                raise RuntimeError(f"Could not establish nightly inclusion for PR #{number}")
        if not all(isinstance(pull[key]["sha"], str) and re.fullmatch(r"[0-9a-f]{40}", pull[key]["sha"])
                   for key in ("head", "base")):
            raise ValueError(f"PR #{number} requires exact commit IDs")
        pulls[number] = {"number": number, "title": pull["title"],
                         "headSha": pull["head"]["sha"], "baseSha": pull["base"]["sha"],
                         "headRef": pull["head"]["ref"], "baseRef": pull["base"]["ref"],
                         "author": pull["user"]["login"], "url": pull["html_url"],
                         "headRepository": (pull["head"].get("repo") or {}).get("full_name"),
                         "baseRepository": (pull["base"].get("repo") or {}).get("full_name")}
    return sorted(pulls.values(), key=lambda pull: pull["number"])


def pull_request_inputs(pulls):
    # Main moving and review comments do not change a PR's patch. A retarget or a
    # rebased/force-pushed head does, including when the commit date stays the same.
    return [{key: pull[key] for key in ("number", "headSha", "baseRef")}
            for pull in sorted(pulls, key=lambda pull: pull["number"])]


def debounce_inputs(previous, inputs, now, seconds=120):
    state = previous if previous.get("inputs") == inputs else {"inputs": inputs, "observedAt": now}
    return state, now - state["observedAt"] >= seconds


def build_is_cooling_down(timing, now):
    completed = timing.get("completedAt")
    return completed is not None and now < completed + 30 * 60


def candidate_is_current(repo, status, config):
    # PR changes during a build belong to the next snapshot. Direct pushes to the
    # integration branch still block publication so they cannot be overwritten.
    branch = git("ls-remote", "origin", f"refs/heads/{config['branch']}", cwd=repo).stdout.split()
    if not branch:
        raise RuntimeError("The personal nightly integration branch is missing")
    return branch[0] in {status["baseCommit"], status.get("candidateCommit")}


def fetch_pull_requests(repo, config, pulls):
    remote = f"https://github.com/{config['upstreamRepository']}.git"
    if pulls:
        git("fetch", remote, *[f"+refs/pull/{pull['number']}/head:refs/personal-sync/{pull['number']}"
                               for pull in pulls], cwd=repo)
    for pull in pulls:
        fetched = git("rev-parse", f"refs/personal-sync/{pull['number']}", cwd=repo).stdout.strip()
        if fetched != pull["headSha"]:
            raise RuntimeError(f"PR #{pull['number']} changed while fetching; retry discovery")
    missing = [sha for sha in sorted({pull["baseSha"] for pull in pulls})
               if git("cat-file", "-e", f"{sha}^{{commit}}", cwd=repo, check=False).returncode]
    if missing:
        git("fetch", remote, *missing, cwd=repo)
    for pull in pulls:
        pull["baseSha"] = git("merge-base", pull["baseSha"], pull["headSha"], cwd=repo).stdout.strip()


def ordered_pull_requests(pulls):
    pending = sorted(pulls, key=lambda pull: pull["number"])
    ordered = []
    while pending:
        heads = {(pull.get("headRepository"), pull["headRef"]) for pull in pending}
        ready = [pull for pull in pending if (pull.get("baseRepository"), pull["baseRef"]) not in heads]
        if not ready:
            raise ValueError("The PR input set has a cyclic branch dependency")
        for pull in ready:
            ordered.append(pull)
            pending.remove(pull)
    return ordered


def merge_delta(repo, base, head):
    """Give ort an explicit merge base without importing a PR's upstream history."""
    current_tree = git("rev-parse", "HEAD^{tree}", cwd=repo).stdout.strip()
    incoming_tree = git("rev-parse", f"{head}^{{tree}}", cwd=repo).stdout.strip()
    current = git("commit-tree", current_tree, "-p", base, "-m", "Assembly base", cwd=repo).stdout.strip()
    incoming = git("commit-tree", incoming_tree, "-p", base, "-m", "Assembly delta", cwd=repo).stdout.strip()
    git("reset", "--hard", current, cwd=repo)
    # Reuse only exact conflict resolutions recorded by Git; new conflicts still stop.
    result = git("-c", "rerere.enabled=true", "-c", "rerere.autoupdate=true", "merge",
                 "--no-commit", "--no-ff", incoming, cwd=repo, check=False)
    conflicts = git("diff", "--name-only", "--diff-filter=U", cwd=repo).stdout.splitlines()
    if result.returncode and not conflicts and not (Path(repo) / ".git" / "MERGE_HEAD").exists():
        raise RuntimeError("The PR merge failed without file conflicts: " + result.stderr)
    return conflicts


def assemble(repo, tag, config, pulls, resolutions):
    """Replace the PR baseline, then merge the personal-only delta onto it."""
    if git("status", "--porcelain", cwd=repo).stdout:
        raise ValueError("PR synchronization requires a clean checkout")
    original = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
    upstream = git("rev-parse", f"{tag}^{{commit}}", cwd=repo).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="t3-nightly-assembly-") as directory:
        checkout = Path(directory) / "checkout"
        git("clone", "--shared", "--no-checkout", "--no-tags", str(repo), str(checkout))
        git("config", "user.name", "personal-nightly", cwd=checkout)
        git("config", "user.email", "personal-nightly@users.noreply.github.com", cwd=checkout)
        git("checkout", "--detach", upstream, cwd=checkout)
        for key, files in resolutions.items():
            if not re.fullmatch(r"[0-9a-f]{40}", key) or set(files) != {"preimage", "postimage"}:
                raise ValueError("Invalid recorded Git conflict resolution")
            cache = checkout / ".git" / "rr-cache" / key
            cache.mkdir(parents=True)
            for name, content in files.items():
                (cache / name).write_text(content)
        for pull in ordered_pull_requests(pulls):
            previous = git("rev-parse", "HEAD", cwd=checkout).stdout.strip()
            conflicts = merge_delta(checkout, pull["baseSha"], pull["headSha"])
            if conflicts:
                return {"conflicts": conflicts, "conflictPullRequest": pull["number"]}
            tree = git("write-tree", cwd=checkout).stdout.strip()
            imported = git("commit-tree", tree, "-p", previous, "-m",
                           f"{pull['title']} (personal import #{pull['number']})", cwd=checkout).stdout.strip()
            git("reset", "--hard", imported, cwd=checkout)
        baseline = git("rev-parse", "HEAD", cwd=checkout).stdout.strip()
        conflicts = merge_delta(checkout, config["prBaseline"], original)
        if conflicts:
            return {"conflicts": conflicts}
        config.update(upstreamTag=tag, pullRequests=pulls, prBaseline=baseline)
        (checkout / "personal-nightly.json").write_text(json.dumps(config, indent=2) + "\n")
        git("add", "personal-nightly.json", cwd=checkout)
        tree = git("write-tree", cwd=checkout).stdout.strip()
        candidate = git("commit-tree", tree, "-p", original, "-p", baseline,
                        "-m", f"chore: synchronize personal PRs with {tag}", cwd=checkout).stdout.strip()
        git("update-ref", "refs/heads/candidate", candidate, cwd=checkout)
        git("fetch", str(checkout), "refs/heads/candidate", cwd=repo)
        git("reset", "--hard", "FETCH_HEAD", cwd=repo)
    return {"conflicts": []}


def prepare(repo, tag, run_number, published_releases=(), pull_requests=None, resolutions=None):
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
    same_pulls = pull_requests is None or pull_request_inputs(config.get("pullRequests", [])) == pull_request_inputs(pull_requests)
    if config["upstreamTag"] == tag and same_pulls and published is not None:
        return {"schema": 1, "phase": "ready", "skipBuild": True, "upstreamTag": tag,
                "conflicts": [], "releasedVersion": published["tag_name"].removeprefix("v"),
                "sequence": sequence, "candidateCommit": base,
                "runUrl": f"https://github.com/{config['repository']}/actions/runs/{os.environ.get('GITHUB_RUN_ID', run_number)}"}
    assembly = {}
    if pull_requests is not None:
        assembly = assemble(repo, tag, config, pull_requests, resolutions or {})
        conflicts = assembly["conflicts"]
    elif config["upstreamTag"] == tag:
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
        **assembly,
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


def nightly_version_key(tag):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)", tag)
    return tuple(map(int, match.groups())) if match else None


def published_release_ready(repo, release, ref, version, branch="FETCH_HEAD"):
    """A later personal fix does not invalidate an already published candidate."""
    return (
        re.fullmatch(r"[0-9a-f]{40}", ref) is not None
        and nightly_version_key(version) is not None
        and release.get("draft") is False
        and release.get("target_commitish") == ref
        and release.get("tag_name") == f"v{version}"
        and git("merge-base", "--is-ancestor", ref, branch, cwd=repo, check=False).returncode == 0
    )


def release_change_items(body):
    """Keep upstream changes without contributor lists or comparison footers."""
    items = []
    for line in (body or "").splitlines():
        line = line.strip()
        heading = re.sub(r"[#*_\x60]", "", line).strip().casefold()
        if heading == "new contributors" or heading.startswith("full changelog"):
            break
        if not line or line.startswith("#") or "/compare/" in line:
            continue
        line = re.sub(r"^(?:[-*]\s+|\d+[.)]\s+)", "", line)
        if line not in items:
            items.append(line)
    return items


def release_notes(repo, ref, version, personal_releases, upstream_releases):
    """Compare with the last published build, including fixes outside the PR manifest."""
    version_key = nightly_version_key(version)
    if version_key is None:
        raise ValueError("Release notes require an exact personal nightly version")
    config = json.loads(git("show", f"{ref}:personal-nightly.json", cwd=repo).stdout)
    upstream_tag = config["upstreamTag"]
    upstream_key = nightly_version_key(upstream_tag)
    if upstream_key is None:
        raise ValueError("The incorporated upstream nightly is invalid")
    upstream_sha = git("rev-parse", f"{upstream_tag}^{{commit}}", cwd=repo).stdout.strip()
    previous = max(
        (release for release in personal_releases
         if release.get("draft") is False
         and (key := nightly_version_key(release.get("tag_name", ""))) is not None
         and key < version_key),
        key=lambda release: nightly_version_key(release["tag_name"]),
        default=None,
    )
    previous_sha = None
    previous_key = None
    previous_config = {}
    if previous is not None:
        previous_sha = previous["target_commitish"]
        if re.fullmatch(r"[0-9a-f]{40}", previous_sha) is None:
            raise ValueError("The previous personal release must identify its exact source commit")
        git("merge-base", "--is-ancestor", previous_sha, ref, cwd=repo)
        previous_config = json.loads(git("show", f"{previous_sha}:personal-nightly.json", cwd=repo).stdout)
        previous_key = nightly_version_key(previous_config["upstreamTag"])
        if previous_key is None or previous_key > upstream_key:
            raise ValueError("The previous build must not use a newer upstream nightly")

    official = [release for release in upstream_releases
                if release.get("draft") is False
                and nightly_version_key(release.get("tag_name", "")) is not None]
    if not any(release["tag_name"] == upstream_tag for release in official):
        raise ValueError(f"Missing official release metadata for {upstream_tag}")
    included = sorted(
        (release for release in official
         if (previous_key is None and release["tag_name"] == upstream_tag)
         or (previous_key is not None
             and previous_key < nightly_version_key(release["tag_name"]) <= upstream_key)),
        key=lambda release: nightly_version_key(release["tag_name"]),
    )
    lines = ["## Upstream changes"]
    seen = set()
    for release in included:
        items = release_change_items(release.get("body"))
        if not items:
            raise ValueError(f"Missing official change notes for {release['tag_name']}")
        lines += ["", f"### [{release['tag_name']}](https://github.com/{config['upstreamRepository']}/releases/tag/{release['tag_name']})", ""]
        for item in items:
            if item not in seen:
                lines.append(f"- {item}")
                seen.add(item)
    if not included:
        lines += ["", f"### Unchanged from [{upstream_tag}](https://github.com/{config['upstreamRepository']}/releases/tag/{upstream_tag})."]

    if config.get("prBaseline"):
        old_pulls = {pull["number"]: pull for pull in previous_config.get("pullRequests", [])}
        current_pulls = {pull["number"]: pull for pull in config.get("pullRequests", [])}
        changes = []
        for number in sorted(old_pulls.keys() | current_pulls.keys()):
            old, current = old_pulls.get(number), current_pulls.get(number)
            if old and current and old["headSha"] == current["headSha"]:
                continue
            label = "Removed" if current is None else "Added" if old is None else "Updated"
            pull = current or old
            changes.append(f"- {label} [#{number}](https://github.com/{config['upstreamRepository']}/pull/{number}): {pull['title']}")
        if changes:
            lines += ["", "## PR changes", "", *changes]

    excluded = [f"^{upstream_sha}"] + ([f"^{previous_sha}"] if previous_sha else [])
    commits = git("log", "--reverse", "--no-merges", "--format=%H%x00%s", ref, *excluded, "--", cwd=repo).stdout.splitlines()
    personal = []
    for commit in commits:
        sha, subject = commit.split("\0", 1)
        if re.fullmatch(r"chore: track v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+", subject):
            continue
        if config.get("prBaseline") and "(personal import #" in subject:
            continue
        subject = re.sub(r"personal import #(\d+)", lambda match: f"personal import [#{match[1]}](https://github.com/{config['upstreamRepository']}/pull/{match[1]})", subject)
        personal.append(f"- {subject} ([{sha[:7]}](https://github.com/{config['repository']}/commit/{sha}))")
    if personal:
        lines += ["", "## Personal changes", "", *personal]
    else:
        lines += ["", "## Personal changes (none)"]
    return "\n".join(lines).rstrip() + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "status", "notes", "verify"])
    parser.add_argument("--tag")
    parser.add_argument("--run-number", default=os.environ.get("GITHUB_RUN_ID"))
    parser.add_argument("--phase", choices=["ready", "failed", "conflict", "superseded"])
    parser.add_argument("--release-index", type=Path)
    parser.add_argument("--upstream-release-index", type=Path)
    parser.add_argument("--notes-file", type=Path)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--version")
    parser.add_argument("--published-release", type=Path)
    parser.add_argument("--sync-prs", action="store_true")
    args = parser.parse_args()
    repo = Path.cwd()
    status_path = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "personal-nightly-status.json"
    if args.command == "verify":
        status = json.loads(status_path.read_text())
        config = json.loads((repo / "personal-nightly.json").read_text())
        phase = "current" if candidate_is_current(repo, status, config) else "superseded"
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a") as stream:
                stream.write(f"phase={phase}\n")
        if phase == "superseded":
            print("Personal changes advanced during this build; skipping publication until the next eligible check")
        return
    if args.command == "notes":
        if not all([args.release_index, args.upstream_release_index, args.notes_file, args.version]):
            parser.error("notes requires --release-index, --upstream-release-index, --notes-file, and --version")
        upstream = json.loads(args.upstream_release_index.read_text())
        if upstream and isinstance(upstream[0], list):
            upstream = [release for page in upstream for release in page]
        notes = release_notes(repo, args.ref, args.version, json.loads(args.release_index.read_text()), upstream)
        args.notes_file.write_text(notes)
        return
    if args.command == "prepare":
        releases = json.loads(args.release_index.read_text()) if args.release_index else []
        pulls, resolutions, inputs = None, None, None
        if args.sync_prs:
            config = json.loads((repo / "personal-nightly.json").read_text())
            if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
                selected = update_selected_pull_requests(repo, config,
                    os.environ.get("PERSONAL_NIGHTLY_INCLUDE_PRS", ""),
                    os.environ.get("PERSONAL_NIGHTLY_REMOVE_PRS", ""),
                    int(os.environ.get("PERSONAL_NIGHTLY_SEQUENCE") or time.time_ns() // 1_000_000))
            else:
                selected = set(read_state(repo, "included-prs.json").get("numbers", []))
            pulls = discover_included_pull_requests(repo, config, args.tag, selected)
            resolutions = read_state(repo, "resolutions.json")
            # A newly recorded resolution can settle a conflict without any PR or branch change.
            inputs = {"upstreamTag": args.tag, "pullRequests": pull_request_inputs(pulls),
                      "resolutions": hashlib.sha256(json.dumps(resolutions, sort_keys=True).encode()).hexdigest()}
            forced = (os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
                      and os.environ.get("PERSONAL_NIGHTLY_FORCE") == "true")
            previous = read_state(repo, "status.json")
            original = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
            retry_suppressed = (not forced and previous.get("phase") in ("failed", "conflict")
                                and previous.get("inputs") == inputs and previous.get("baseCommit") == original)
            observed = read_state(repo, "inputs.json")
            observation, stable = debounce_inputs(observed, inputs, time.time())
            if observation != observed:
                write_state(repo, "inputs.json", observation)
            timing = read_state(repo, "build-timing.json")
            cooling_down = build_is_cooling_down(timing, time.time())
            if retry_suppressed or (not forced and (not stable or cooling_down)):
                # Waiting does not erase the last failure or advertise an unpublished release.
                status_path.write_text(json.dumps({"phase": "debouncing"}))
                if output := os.environ.get("GITHUB_OUTPUT"):
                    with open(output, "a") as stream:
                        stream.write("phase=debouncing\n")
                return
            fetch_pull_requests(repo, config, pulls)
        status = prepare(repo, args.tag, args.run_number, releases, pulls, resolutions)
        if inputs is not None:
            status["inputs"] = inputs
            status["pullRequests"] = pulls
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
            git("push", "origin", f"HEAD:refs/heads/{candidate_branch}", cwd=repo)
            write_status(repo, status)
    else:
        if status_path.exists():
            status = json.loads(status_path.read_text())
        else:
            config = json.loads((repo / "personal-nightly.json").read_text())
            status = {"schema": 1, "upstreamTag": config["upstreamTag"], "conflicts": [], "releasedVersion": None, "sequence": int(os.environ["PERSONAL_NIGHTLY_SEQUENCE"]), "runUrl": f"https://github.com/{config['repository']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"}
        phase = args.phase
        if phase == "superseded":
            # A discarded candidate does not change the last available release.
            status["releasedVersion"] = read_state(repo, "status.json").get("releasedVersion")
            phase = "ready" if status["releasedVersion"] else "building"
            status.pop("candidateCommit", None)
            status.pop("candidateVersion", None)
        elif args.published_release:
            release = json.loads(args.published_release.read_text())
            phase = "ready" if published_release_ready(repo, release, args.ref, args.version or "") else "failed"
        status["phase"] = phase
        if phase == "ready" and args.phase != "superseded":
            if "candidateVersion" not in status:
                if nightly_version_key(args.version or "") is None:
                    parser.error("ready status without an artifact requires --version")
                status["candidateVersion"] = args.version
                status["candidateCommit"] = args.ref
            status["releasedVersion"] = status["candidateVersion"]
        if re.fullmatch(r"[0-9a-f]{40}", status.get("candidateCommit", args.ref)):
            write_state(repo, "build-timing.json", {
                "completedAt": time.time(), "sequence": status["sequence"],
            })
        write_status(repo, status)


if __name__ == "__main__":
    main()
