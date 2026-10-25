#!/usr/bin/env python3
"""Prepare a nightly merge without advancing the last working personal branch."""

import argparse
import contextlib
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path


def git(*args, cwd=None, check=True, input=None):
    # Wait for housekeeping before a caller can dispose of a temporary repository.
    return subprocess.run(["git", "-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false", *args],
                          cwd=cwd, check=check, input=input, text=True, capture_output=True)


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
        if name == "status.json" and state["phase"] == "waiting":
            # Installed clients know only these phases; the optional marker carries the wait.
            state = {**state, "phase": "ready" if state["releasedVersion"] else "building"}
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


def inputs_stabilized_externally(inputs, base_commit, digest):
    # Only the exact snapshot observed by the VPS may skip the duplicate debounce.
    snapshot = {"inputs": inputs, "baseCommit": base_commit}
    return digest == hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()


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


# The workflow runs these from the integration branch with the fork's write credentials,
# and assembly writes the manifest in place, so a symlinked one would redirect that write.
RELEASE_TOOLING = re.compile(r"\.github/|scripts/personal-nightly\.py$|personal-nightly\.json$")


def owned(config, pull):
    return pull.get("author", "").casefold() == config["repository"].split("/")[0].casefold()


def release_tooling_changes(repo, config, pull):
    """Release tooling another author's PR changes. The owner's own PRs may change it."""
    if owned(config, pull):
        return []
    # -z keeps unusual names unquoted so the prefix match cannot be bypassed.
    changed = git("diff", "--name-only", "--no-renames", "-z", pull["baseSha"], pull["headSha"], cwd=repo).stdout
    return [path for path in changed.split("\0") if RELEASE_TOOLING.match(path)]


IDENTIFIER = r"[A-Za-z_$][A-Za-z0-9_$]*"
IMPORT = re.compile(r"import\s+(?:([^;\"']*?)\s+from\s+)?([\"'])([^\"'\n]+)\2\s*;", re.DOTALL)
TRIVIA = re.compile(r"(?:\s+|//[^\n]*(?:\n|$)|/\*.*?\*/)*", re.DOTALL)
IMPORT_CONFLICT = re.compile(
    r"^<<<<<<< ours\n(.*?)^\|\|\|\|\|\|\| base\n(.*?)^=======\n(.*?)^>>>>>>> theirs\n",
    re.MULTILINE | re.DOTALL,
)


def import_bindings(text, named_only=False):
    """Read the initial import declarations; unsupported syntax is left for a person."""
    bindings, position = {}, 0
    while True:
        position = (re.compile(r"\s*") if named_only else TRIVIA).match(text, position).end()
        declaration = IMPORT.match(text, position)
        if declaration is None:
            return bindings, position
        clause, _, module = declaration.groups()
        if "\\" in module:
            return None
        position = declaration.end()
        if clause is None:
            if named_only:
                return None
            continue
        clause = clause.strip()
        type_only = clause.startswith("type ")
        if type_only:
            clause = clause[5:].strip()
        names = []
        if not clause.startswith("{"):
            if named_only:
                return None
            first, separator, rest = clause.partition(",")
            namespace = re.fullmatch(r"\*\s+as\s+(" + IDENTIFIER + r")", first.strip())
            if namespace and not separator:
                names.append((namespace[1], "*", "type" if type_only else "value"))
            elif re.fullmatch(IDENTIFIER, first.strip()):
                names.append((first.strip(), "default", "type" if type_only else "value"))
            else:
                return None
            clause = rest.strip() if separator else ""
        if clause:
            if not clause.startswith("{") or not clause.endswith("}"):
                return None
            members = clause[1:-1].strip().removesuffix(",").split(",")
            for member in members:
                match = re.fullmatch(r"\s*(type\s+)?(" + IDENTIFIER + r")(?:\s+as\s+(" + IDENTIFIER + r"))?\s*", member)
                if match is None or (named_only and match[3]):
                    return None
                names.append((match[3] or match[2], match[2], "type" if type_only else "inline" if match[1] else "value"))
        for local, imported, kind in names:
            if local in bindings:
                return None
            bindings[local] = (module, imported, kind)


def additive_imports(base, ours, theirs):
    sides = []
    for side in (base, ours, theirs):
        parsed = import_bindings(side, named_only=True)
        if parsed is None or parsed[1] != len(side):
            return None
        sides.append(parsed[0])
    original, left, right = sides
    if not left or not right or any(left.get(name) != value or right.get(name) != value
                                   for name, value in original.items()):
        return None
    if any(name in left and left[name] != value for name, value in right.items()):
        return None
    if any([name for name in side if name in original] != list(original) for side in (left, right)):
        return None
    groups = {}
    for module, imported, kind in (left | right).values():
        groups.setdefault((module, kind == "type"), []).append(("type " if kind == "inline" else "") + imported)
    merged = "".join(f"import {'type ' if is_type else ''}{{ {', '.join(names)} }} from {json.dumps(module, ensure_ascii=False)};\n"
                     for (module, is_type), names in groups.items())
    parsed = import_bindings(merged, named_only=True)
    if parsed is None:
        return None
    combined = parsed[0]
    # Import evaluation order can initialize test setup; keep both sides' ordering constraints.
    if any([name for name in combined if name in side] != list(side) for side in (left, right)):
        return None
    return merged


def reconcile_test_imports(checkout, path):
    """Only additive named imports at the top of an existing test file can be combined."""
    if not re.search(r"\.(?:test|spec)\.[cm]?[jt]sx?$", path):
        return False
    entries = git("ls-files", "--unmerged", "-z", "--", path, cwd=checkout).stdout.split("\0")
    modes = [entry.split()[0] for entry in entries if entry]
    if len(modes) != 3 or len(set(modes)) != 1 or modes[0] not in ("100644", "100755"):
        return False
    sides = [git("show", f":{stage}:{path}", cwd=checkout).stdout for stage in (1, 2, 3)]
    with tempfile.TemporaryDirectory(prefix="t3-nightly-imports-") as directory:
        files = [Path(directory) / name for name in ("base", "ours", "theirs")]
        for file, side in zip(files, sides):
            file.write_text(side)
        merged = git("merge-file", "--stdout", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs",
                     str(files[1]), str(files[0]), str(files[2]), cwd=checkout, check=False)
    if not 0 < merged.returncode < 128:
        return False
    result, remaining = "", merged.stdout
    while conflict := IMPORT_CONFLICT.search(remaining):
        prefix = result + remaining[:conflict.start()]
        parsed = import_bindings(prefix)
        if parsed is None or parsed[1] != len(prefix):
            return False
        ours, base, theirs = conflict.groups()
        combined = additive_imports(base, ours, theirs)
        if combined is None:
            return False
        result = prefix + combined
        remaining = remaining[conflict.end():]
    result += remaining
    if re.search(r"^(?:<{7}|\|{7}|={7}|>{7})", result, re.MULTILINE) or import_bindings(result) is None:
        return False
    (Path(checkout) / path).write_text(result)
    git("add", "--", path, cwd=checkout)
    return True


def merge_delta(repo, base, head, keep_deleted=lambda path: False):
    """Give ort an explicit merge base without importing a PR's upstream history."""
    current_tree = git("rev-parse", "HEAD^{tree}", cwd=repo).stdout.strip()
    incoming_tree = git("rev-parse", f"{head}^{{tree}}", cwd=repo).stdout.strip()
    current = git("commit-tree", current_tree, "-p", base, "-m", "Assembly base", cwd=repo).stdout.strip()
    incoming = git("commit-tree", incoming_tree, "-p", base, "-m", "Assembly delta", cwd=repo).stdout.strip()
    git("reset", "--hard", current, cwd=repo)
    # Reuse recorded resolutions before considering additive test imports.
    result = git("-c", "rerere.enabled=true", "-c", "rerere.autoupdate=true", "merge",
                 "--no-commit", "--no-ff", incoming, cwd=repo, check=False)
    conflicts = git("diff", "--name-only", "--diff-filter=U", cwd=repo).stdout.splitlines()
    if result.returncode and not conflicts and not (Path(repo) / ".git" / "MERGE_HEAD").exists():
        raise RuntimeError("The PR merge failed without file conflicts: " + result.stderr)
    # rerere cannot record keeping a file upstream deleted and the PR still modifies.
    kept = [path for path in conflicts if deleted_here(repo, path) and keep_deleted(path)]
    if kept:
        git("rm", "--quiet", "--", *kept, cwd=repo)
    return [path for path in conflicts if path not in kept and not reconcile_test_imports(repo, path)]


def deleted_here(repo, path):
    entries = git("ls-files", "--unmerged", "-z", "--", path, cwd=repo).stdout.split("\0")
    return {entry.split("\t")[0].split()[2] for entry in entries if entry} == {"1", "3"}


LOCKFILE = "pnpm-lock.yaml"
# pnpm reads these before resolving; another author's change to them must not run in the
# job that holds the fork's write credentials.
PACKAGE_MANAGER_CONFIG = re.compile(r"(?:.*/)?(?:\.npmrc|\.pnpmfile\.[cm]?js)|pnpm-workspace\.yaml")
PNPM_NETWORK_ERROR = re.compile(r"ERR_PNPM_(?:META_FETCH_FAIL|FETCH_\w+)|E(?:CONNRESET|TIMEDOUT|NOTFOUND|AI_AGAIN|CONNREFUSED)")


def package_manager_policy(repo, config, pulls, start):
    """Lockfile reconciliation runs the official nightly's pnpm on owner-trusted configuration."""
    for pull in pulls:
        if not owned(config, pull) and any(
                PACKAGE_MANAGER_CONFIG.fullmatch(path) for path in changed_paths(repo, pull["baseSha"], pull["headSha"])):
            return {"reason": f"PR #{pull['number']} by another author changes package manager configuration"}
    manifest = git("show", f"{start}:package.json", cwd=repo, check=False)
    pin = json.loads(manifest.stdout).get("packageManager", "") if manifest.returncode == 0 else ""
    if not re.fullmatch(r"pnpm@\d+\.\d+\.\d+(?:\+\S+)?", pin):
        return {"reason": "The official nightly does not pin pnpm"}
    return {"packageManager": pin}


def pnpm(checkout, *args):
    # Candidate manifests are untrusted input here: no lifecycle scripts, no pnpmfile, no tokens.
    env = {key: value for key, value in os.environ.items()
           if not re.search(r"TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|_KEY", key, re.IGNORECASE)}
    try:
        result = subprocess.run(["pnpm", *args, "--ignore-scripts", "--ignore-pnpmfile"] if args[0] == "install"
                                else ["pnpm", *args], cwd=checkout, env=env, text=True, capture_output=True)
    except FileNotFoundError:
        return None
    if result.returncode and PNPM_NETWORK_ERROR.search(result.stdout + result.stderr):
        # A registry outage must fail the run so the next check retries it, not record a conflict.
        raise RuntimeError("pnpm could not reach the registry: " + (result.stdout + result.stderr)[-2000:])
    return result


def unquote(text):
    if len(text) >= 2 and text[0] == text[-1] == "'":
        return text[1:-1].replace("''", "'")
    if len(text) >= 2 and text[0] == text[-1] == '"':
        return json.loads(text)
    return text


def yaml_entries(text):
    """Block-style YAML as {(document, *keys): scalar}. pnpm writes lockfiles in this subset only."""
    entries, stack, document, explicit = {}, [], 0, None
    for line in text.splitlines():
        if line == "---":
            document, stack = document + 1, []
            continue
        stripped = line.lstrip(" ")
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = (document, *(key for _, key in stack))
        if stripped.startswith("- "):
            entries[(*path, "-", unquote(stripped[2:].strip()))] = ""
            continue
        # pnpm writes keys longer than YAML's implicit key limit as "? key" then ": value".
        if stripped.startswith("? "):
            explicit = unquote(stripped[2:].strip())
            entries[(*path, explicit)] = ""
            continue
        if stripped.startswith(": ") and explicit is not None:
            stack.append((indent, explicit))
            path, indent, stripped, explicit = (*path, explicit), indent + 2, stripped[2:].lstrip(" "), None
            if not re.match(r"('(?:[^']|'')*'|[^'\"#][^#]*?):(?: |$)", stripped):
                entries[path] = unquote(stripped)
                continue
        match = re.fullmatch(r"('(?:[^']|'')*'|\"(?:[^\"\\]|\\.)*\"|[^'\"#?:][^#]*?):(?: +(.*))?", stripped)
        if match is None:
            raise ValueError(f"Unrecognized YAML line: {stripped[:80]}")
        key, value = unquote(match[1]), (match[2] or "").strip()
        entries[(*path, key)] = unquote(value)
        if not value:
            stack.append((indent, key))
    return entries


def patch_hashes(entries):
    return {path[-1]: value for path, value in entries.items() if len(path) == 3 and path[1] == "patchedDependencies"}


def lockfile_entries(text):
    """Patch hashes follow the merged patch files, so they compare by dependency, not content."""
    for key, value in patch_hashes(yaml_entries(text)).items():
        text = text.replace(value, f"<patch {key}>")
    return yaml_entries(text)


def unexpected_lockfile_change(base, ours, theirs, result):
    """Every entry must be what a three-way merge of the two sides' lockfiles gives.

    Versions neither side resolved, dropped changes, and entries both sides changed differently
    are refused, so a dependency change is never decided here.
    """
    base, ours, theirs, result = map(lockfile_entries, (base, ours, theirs, result))
    for path in sorted(base.keys() | ours.keys() | theirs.keys() | result.keys(), key=str):
        values = [entries.get(path) for entries in (base, ours, theirs)]
        if values[1] != values[2] and values[0] not in values[1:]:
            return f"Both sides change {'/'.join(map(str, path[1:]))}"
        expected = values[2] if values[1] == values[0] else values[1]
        if result.get(path) != expected:
            return f"Regeneration changes {'/'.join(map(str, path[1:]))}"
    return None


def reconcile_lockfile(checkout, package_manager):
    """Rebuild a conflicted pnpm lockfile from the merged manifests and patches, or explain why not.

    Starting from this side's lockfile with only the merged patches' hashes updated keeps pnpm
    incremental: a fresh resolution rewrites unrelated peer suffixes throughout the file.
    """
    sides = [git("show", f":{stage}:{LOCKFILE}", cwd=checkout, check=False) for stage in (1, 2, 3)]
    if any(side.returncode for side in sides):
        return "The lockfile was added or deleted on one side"
    base, ours, theirs = (side.stdout for side in sides)
    manifest = json.loads((checkout / "package.json").read_text())
    if manifest.get("packageManager") != package_manager:
        return f"The merged package.json does not pin {package_manager}"
    version = pnpm(checkout, "--version")
    pinned = package_manager.removeprefix("pnpm@").split("+")[0]
    if version is None or version.returncode or version.stdout.strip().splitlines()[-1:] != [pinned]:
        return f"pnpm {pinned} is unavailable"
    workspace = yaml_entries((checkout / "pnpm-workspace.yaml").read_text()) if (checkout / "pnpm-workspace.yaml").exists() else {}
    patches = patch_hashes(workspace)
    seeded = ours
    for key, previous in patch_hashes(yaml_entries(ours)).items():
        if key in patches and (checkout / patches[key]).is_file():
            seeded = seeded.replace(previous, hashlib.sha256((checkout / patches[key]).read_bytes()).hexdigest())
    (checkout / LOCKFILE).write_text(seeded)
    for frozen in (False, True):
        installed = pnpm(checkout, "install", "--lockfile-only", "--frozen-lockfile" if frozen else "--no-frozen-lockfile")
        if installed.returncode:
            error = re.findall(r"ERR_PNPM_\w+", installed.stdout + installed.stderr)
            return f"pnpm could not update the lockfile ({error[0] if error else f'exit {installed.returncode}'})"
        if not frozen:
            try:
                reason = unexpected_lockfile_change(base, ours, theirs, (checkout / LOCKFILE).read_text())
            except ValueError as error:
                reason = f"The lockfile could not be compared: {error}"
            if reason:
                return reason
    untracked = git("ls-files", "--others", "-z", cwd=checkout).stdout
    # The unmerged lockfile is listed once per stage.
    if untracked or set(git("diff", "--name-only", cwd=checkout).stdout.split()) != {LOCKFILE}:
        return "pnpm changed files other than the lockfile"
    git("add", "--", LOCKFILE, cwd=checkout)
    return None


def settle_lockfile(checkout, conflicts, policy):
    """The conflicts left after a generated-lockfile conflict is reconciled, and why one stayed."""
    if LOCKFILE not in conflicts:
        return conflicts, None
    reason = (policy.get("reason")
              or ("Other files also conflict" if conflicts != [LOCKFILE] else None)
              or reconcile_lockfile(checkout, policy["packageManager"]))
    if reason is None:
        return [], None
    # A refused attempt leaves the same unmerged index entries, so the conflict identity holds.
    git("checkout", "--conflict=merge", "--", LOCKFILE, cwd=checkout)
    return conflicts, {"path": LOCKFILE, "reason": reason}


def prime_checkout(checkout, start, resolutions):
    git("config", "user.name", "personal-nightly", cwd=checkout)
    git("config", "user.email", "personal-nightly@users.noreply.github.com", cwd=checkout)
    git("checkout", "--detach", start, cwd=checkout)
    for key, files in resolutions.items():
        if not re.fullmatch(r"[0-9a-f]{40}", key) or set(files) != {"preimage", "postimage"}:
            raise ValueError("Invalid recorded Git conflict resolution")
        cache = checkout / ".git" / "rr-cache" / key
        cache.mkdir(parents=True)
        for name, content in files.items():
            (cache / name).write_text(content)


@contextlib.contextmanager
def assembly_checkout(repo, start, resolutions):
    """A disposable clone with the recorded resolutions; nothing leaves it unless fetched back."""
    with tempfile.TemporaryDirectory(prefix="t3-nightly-assembly-") as directory:
        checkout = Path(directory) / "checkout"
        git("clone", "--shared", "--no-checkout", "--no-tags", str(repo), str(checkout))
        prime_checkout(checkout, start, resolutions)
        yield checkout


def import_pull_requests(checkout, config, pulls, original, policy, reconciled=None):
    included = {pull["number"] for pull in config.get("pullRequests", [])}
    for pull in pulls:
        previous = git("rev-parse", "HEAD", cwd=checkout).stdout.strip()

        # The last candidate, which already included this PR, dropped the file.
        def reviewed_deletion(path, pull=pull):
            return pull["number"] in included and git(
                "cat-file", "-e", f"{original}:{path}", cwd=checkout, check=False).returncode != 0

        tooling = release_tooling_changes(checkout, config, pull)
        if tooling:
            return {"conflicts": tooling, "conflictPullRequest": pull["number"], "conflictStage": "pull_request"}
        merged = merge_delta(checkout, pull["baseSha"], pull["headSha"], reviewed_deletion)
        conflicts, lockfile = settle_lockfile(checkout, merged, policy)
        if conflicts:
            return {"conflicts": conflicts, "conflictPullRequest": pull["number"], "conflictStage": "pull_request",
                    **({"lockfileReconciliation": lockfile} if lockfile else {})}
        if merged and reconciled is not None:
            reconciled.append({"conflictStage": "pull_request", "pullRequest": pull["number"]})
        tree = git("write-tree", cwd=checkout).stdout.strip()
        imported = git("commit-tree", tree, "-p", previous, "-m",
                       f"{pull['title']} (personal import #{pull['number']})", cwd=checkout).stdout.strip()
        git("reset", "--hard", imported, cwd=checkout)
    return None


def unmerged_entries(checkout):
    return sorted(entry for entry in git("ls-files", "--unmerged", "-z", cwd=checkout).stdout.split("\0") if entry)


def conflict_identity(checkout, number):
    """Unrelated PR changes keep the offending import and its unresolved index entries."""
    entries = unmerged_entries(checkout)
    return {"conflictIdentity": hashlib.sha256(json.dumps([number, entries]).encode()).hexdigest()} if entries else {}


def tree_entry(repo, commit, path):
    entry = git("--literal-pathspecs", "ls-tree", "-z", commit, "--", path, cwd=repo).stdout.rstrip("\0")
    return tuple(entry.split("\t", 1)[0].split()[::2]) if entry else None


def changed_paths(repo, base, head):
    # Without rename detection, a rename lists both of its endpoints.
    return [path for path in git("diff", "--name-only", "--no-renames", "-z", base, head, cwd=repo).stdout.split("\0") if path]


def nightly_wait(repo, checkout, upstream, config, pulls, original, resolutions, stop, policy):
    """NightlyWait evidence that an import stop only lacks upstream files a later official nightly adds.

    Any doubt keeps the conflict actionable. The diagnostic replays stay in disposable clones.
    """
    pull = next((pull for pull in pulls if pull["number"] == stop.get("conflictPullRequest")), None)
    if (pull is None or pull["baseRef"] != "main" or upstream == pull["baseSha"]
            or (pull.get("baseRepository") or "").casefold() != config["upstreamRepository"].casefold()):
        return None
    others = [other for other in pulls if other is not pull]
    if (pull.get("baseRepository"), pull["baseRef"]) in {(other.get("headRepository"), other["headRef"]) for other in others}:
        return None
    if git("merge-base", "--is-ancestor", upstream, pull["baseSha"], cwd=repo, check=False).returncode:
        return None
    paths = stop["conflicts"]
    stages = {}
    for entry in unmerged_entries(checkout):
        info, path = entry.split("\t", 1)
        mode, blob, stage = info.split()
        stages.setdefault(path, {})[stage] = (mode, blob)
    if sorted(stages) != sorted(paths):
        return None
    for path in paths:
        official = tree_entry(checkout, upstream, path)
        expected = {"1": tree_entry(checkout, pull["baseSha"], path), "2": official,
                    "3": tree_entry(checkout, pull["headSha"], path)}
        if (stages[path] != expected or tree_entry(checkout, "HEAD", path) != official
                or expected["1"] == official
                or any(mode not in ("100644", "100755") for mode, _ in expected.values())):
            return None

    def touches(changed):
        return any(change == path or change.startswith(path + "/") or path.startswith(change + "/")
                   for change in changed for path in paths)

    if (touches(changed_paths(repo, config["prBaseline"], original))
            or any(touches(changed_paths(repo, other["baseSha"], other["headSha"])) for other in others)):
        return None
    with assembly_checkout(repo, pull["baseSha"], resolutions) as replay:
        if import_pull_requests(replay, config, pulls[:pulls.index(pull) + 1], original, policy):
            return None
    with assembly_checkout(repo, upstream, resolutions) as replay:
        git("--literal-pathspecs", "checkout", pull["baseSha"], "--", *paths, cwd=replay)
        tree = git("write-tree", cwd=replay).stdout.strip()
        prerequisites = git("commit-tree", tree, "-p", upstream, "-m", "Official prerequisites", cwd=replay).stdout.strip()
        git("reset", "--hard", prerequisites, cwd=replay)
        if (import_pull_requests(replay, config, pulls, original, policy)
                or settle_lockfile(replay, merge_delta(replay, config["prBaseline"], original), policy)[0]):
            return None
    return {"pullRequest": pull["number"], "baseCommit": pull["baseSha"], "paths": paths}


def assemble_into(repo, checkout, tag, upstream, original, config, pulls, resolutions):
    """Replace the PR baseline, then merge the personal-only delta onto it, in a primed checkout."""
    ordered = ordered_pull_requests(pulls)
    policy = package_manager_policy(repo, config, ordered, upstream)
    reconciled = []
    stop = import_pull_requests(checkout, config, ordered, original, policy, reconciled)
    if stop:
        if waiting := nightly_wait(repo, checkout, upstream, config, ordered, original, resolutions, stop, policy):
            return {"conflicts": [], "waiting": waiting}
        return {**stop, **conflict_identity(checkout, stop["conflictPullRequest"])}
    baseline = git("rev-parse", "HEAD", cwd=checkout).stdout.strip()
    merged = merge_delta(checkout, config["prBaseline"], original)
    conflicts, lockfile = settle_lockfile(checkout, merged, policy)
    if conflicts:
        return {"conflicts": conflicts, "conflictStage": "personal",
                **({"lockfileReconciliation": lockfile} if lockfile else {}), **conflict_identity(checkout, None)}
    if merged:
        reconciled.append({"conflictStage": "personal"})
    config.update(upstreamTag=tag, pullRequests=pulls, prBaseline=baseline)
    (checkout / "personal-nightly.json").write_text(json.dumps(config, indent=2) + "\n")
    git("add", "personal-nightly.json", cwd=checkout)
    tree = git("write-tree", cwd=checkout).stdout.strip()
    candidate = git("commit-tree", tree, "-p", original, "-p", baseline,
                    "-m", f"chore: synchronize personal PRs with {tag}", cwd=checkout).stdout.strip()
    git("update-ref", "refs/heads/candidate", candidate, cwd=checkout)
    return {"conflicts": [], "candidate": candidate, **({"lockfileReconciliations": reconciled} if reconciled else {})}


def assemble(repo, tag, config, pulls, resolutions):
    if git("status", "--porcelain", cwd=repo).stdout:
        raise ValueError("PR synchronization requires a clean checkout")
    original = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
    upstream = git("rev-parse", f"{tag}^{{commit}}", cwd=repo).stdout.strip()
    with assembly_checkout(repo, upstream, resolutions) as checkout:
        result = assemble_into(repo, checkout, tag, upstream, original, config, pulls, resolutions)
        if result.pop("candidate", None):
            git("fetch", str(checkout), "refs/heads/candidate", cwd=repo)
            git("reset", "--hard", "FETCH_HEAD", cwd=repo)
    return result


def resolutions_fingerprint(resolutions):
    return hashlib.sha256(json.dumps(resolutions, sort_keys=True).encode()).hexdigest()


def ensure_commits(repo, url, commits):
    """Fetch only missing exact commits, without creating or moving any ref."""
    missing = sorted({sha for sha in commits
                      if git("cat-file", "-e", f"{sha}^{{commit}}", cwd=repo, check=False).returncode})
    if missing:
        git("fetch", "--no-tags", "--no-write-fetch-head", url, *missing, cwd=repo)


def reproduce(repo, status, resolutions, directory):
    """Replay a recorded prepare snapshot in a kept clone, stopping where prepare stopped.

    The clone keeps rerere enabled so a repair's resolutions can be exported with record.
    """
    directory = Path(directory).resolve()
    if directory.exists():
        raise ValueError(f"{directory} already exists")
    fork = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/actions/runs/\d+", status["runUrl"])
    pulls = status["pullRequests"]
    if fork is None or status["inputs"]["pullRequests"] != pull_request_inputs(pulls):
        raise ValueError("The status does not record a complete PR snapshot")
    git("clone", "--quiet", "--no-checkout", "--no-tags", str(repo), str(directory))
    ensure_commits(directory, f"https://github.com/{fork[1]}.git", [status["baseCommit"]])
    config = json.loads(git("show", f"{status['baseCommit']}:personal-nightly.json", cwd=directory).stdout)
    upstream_url = f"https://github.com/{config['upstreamRepository']}.git"
    tag = status["upstreamTag"]
    local = git("rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}", cwd=repo, check=False)
    if local.returncode == 0:
        upstream = local.stdout.strip()
    else:
        refs = dict(line.split("\t")[::-1] for line in git(
            "ls-remote", upstream_url, f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}", cwd=directory).stdout.splitlines())
        upstream = refs.get(f"refs/tags/{tag}^{{}}") or refs.get(f"refs/tags/{tag}")
        if upstream is None:
            raise ValueError(f"{tag} is not an upstream tag")
    ensure_commits(directory, upstream_url, [upstream, *(pull[key] for pull in pulls for key in ("baseSha", "headSha"))])
    prime_checkout(directory, upstream, resolutions)
    git("config", "rerere.enabled", "true", cwd=directory)
    result = assemble_into(directory, directory, tag, upstream, status["baseCommit"], config, pulls, resolutions)
    if candidate := result.pop("candidate", None):
        git("reset", "--hard", candidate, cwd=directory)
        result["candidateCommit"] = candidate
    return {"directory": str(directory), "upstreamCommit": upstream,
            "resolutionsMatchStatus": status["inputs"].get("resolutions") == resolutions_fingerprint(resolutions),
            **result}


def record_resolutions(directory, resolutions):
    """The recorded resolutions plus every conflict resolved with rerere in a repair checkout."""
    updated = dict(resolutions)
    cache = Path(directory) / ".git" / "rr-cache"
    for entry in sorted(cache.iterdir()) if cache.is_dir() else []:
        if re.fullmatch(r"[0-9a-f]{40}", entry.name) and all((entry / name).is_file() for name in ("preimage", "postimage")):
            updated[entry.name] = {name: (entry / name).read_text() for name in ("preimage", "postimage")}
    return updated


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
        "phase": "waiting" if assembly.get("waiting") else "conflict" if conflicts else "building",
        "upstreamTag": tag,
        "conflicts": conflicts,
        "runUrl": f"https://github.com/{config['repository']}/actions/runs/{os.environ.get('GITHUB_RUN_ID', run_number)}",
        "releasedVersion": None,
        "baseCommit": base,
        "sequence": sequence,
        **assembly,
    }
    if status["phase"] != "building":
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
    parser.add_argument("command", choices=["prepare", "status", "notes", "verify", "reproduce", "record"])
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
    parser.add_argument("--status", type=Path, help="reproduce: a recorded status.json")
    parser.add_argument("--resolutions", type=Path, help="reproduce, record: a recorded resolutions.json")
    parser.add_argument("--keep", type=Path, help="reproduce, record: the repair checkout directory")
    parser.add_argument("--output", type=Path, help="record: where to write the updated resolutions.json")
    args = parser.parse_args()
    repo = Path.cwd()
    if args.command in ("reproduce", "record"):
        # Local repair tooling: reads the given files and writes only the kept checkout or output.
        if not args.resolutions or not args.keep or (args.command == "reproduce") != bool(args.status) \
                or (args.command == "record") != bool(args.output):
            parser.error("reproduce requires --status, --resolutions, and --keep; record requires --resolutions, --keep, and --output")
        resolutions = json.loads(args.resolutions.read_text())
        if args.command == "reproduce":
            print(json.dumps(reproduce(repo, json.loads(args.status.read_text()), resolutions, args.keep), indent=2))
        else:
            updated = record_resolutions(args.keep, resolutions)
            args.output.write_text(json.dumps(updated, indent=2, sort_keys=True) + "\n")
            print(json.dumps({"added": sorted(updated.keys() - resolutions.keys()),
                              "resolutions": resolutions_fingerprint(updated)}, indent=2))
        return
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
                      "resolutions": resolutions_fingerprint(resolutions)}
            forced = (os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
                      and os.environ.get("PERSONAL_NIGHTLY_FORCE") == "true")
            previous = read_state(repo, "status.json")
            original = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
            retry_suppressed = (not forced and (previous.get("phase") in ("failed", "conflict") or "waiting" in previous)
                                and previous.get("inputs") == inputs and previous.get("baseCommit") == original)
            observed = read_state(repo, "inputs.json")
            observation, stable = debounce_inputs(observed, inputs, time.time())
            if external_digest := os.environ.get("PERSONAL_NIGHTLY_STABLE_INPUTS", ""):
                stable = inputs_stabilized_externally(inputs, original, external_digest)
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
        if status["phase"] == "building":
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
