# Personal nightly updates

This fork combines the official nightly with the personal changes on
`personal-nightly`. Updates use the existing T3 Code update and restart controls.
If a nightly has merge conflicts or fails its checks, the current build stays
available. A dismissible notification shows the stopped update without shifting
the app layout. Settings → General → About keeps its details and workflow link.

Install a release from [this fork](https://github.com/NikitaMGrimm/t3code/releases)
once before using its updater. An official T3 Code installation follows the
official release feed until replaced with a personal build. Keep the update track
on Nightly. Windows releases also include the matching Linux runtime for WSL.

For a standalone WSL or Linux server, run this fork's `scripts/install.sh`, then
use `t3 service install` for app-controlled server updates. It checks the release
checksum and retains versioned runtimes. The personal VPS uses its existing
deployment coordinator so the app can update its managed container safely.

The Personal nightly GitHub workflow checks for an official nightly, all open
upstream PRs by this fork's owner, and selected upstream PRs every five minutes. It waits until changed PR
inputs have stayed unchanged for two minutes before building. GitHub can delay
scheduled checks. Only one build runs at a time. After a build finishes, checks
wait 30 minutes before starting another; changes during the build and cooldown
are grouped into the next snapshot. The active build finishes from the PR heads
it started with, so new PR pushes do not discard its packages. No rebuild happens
when the inputs are unchanged. To activate it, publish the `personal-nightly`
branch, make it the fork's default branch, and disable the fork's original Release
workflow. Add the Actions secret `PERSONAL_NIGHTLY_TOKEN`: a fine-grained GitHub
token restricted to this fork with Contents and Workflows write permissions. It
is needed to merge upstream workflow changes. The workflow publishes only after
the focused checks and Windows/Linux x64/arm64 builds pass. An unchanged published
head repairs the status feed without rebuilding. An unchanged failed candidate
waits for changed inputs or a forced manual retry instead of repeatedly packaging it.

## Adding your own fixes

Open or update an upstream PR under this fork's owner's account to include it
automatically, including drafts. Each build uses the current open PR heads;
closing an unmerged PR removes its personal import unless you selected it as
described below. A merged PR stays included
until an official nightly contains its merge, then becomes part of that nightly.
Updated or force-pushed PRs replace their previous imports, and stacked
PRs are assembled after their dependencies. A new conflict keeps the previous
release available.

To select an upstream PR, open **Actions → Personal nightly → Run workflow** and
put its GitHub URL or number in **include_prs**. Separate multiple
PRs with spaces or commas. The selection is saved even if the candidate conflicts;
if a build is running, the selection request waits in the queue without replacing
or interrupting that build. Future checks follow each PR's latest head automatically. Put the same URL or
number in **remove_prs** to stop following it. Your own open PRs remain automatic.
Release notes link the included PR changes.

A selected PR stays until you remove it. If upstream closes it without merging,
its last version remains in your build, so select a PR you want to keep whatever
upstream decides, including one of your own. A closed PR no longer receives its
owner's fixes: when it starts conflicting with a newer nightly, remove it or
commit the reconciled change directly as a personal fix.

A selected PR from another author cannot change `.github/`,
`scripts/personal-nightly.py`, or `personal-nightly.json`. The build uses those
files with the fork's write token, so
such a PR stops the build like a conflict until its author drops those changes
or you remove it.

When an owner pushes a conflict fix, the next eligible check retries their new
head with the normal debounce and cooldown. Conflicts with another included PR,
your personal fixes, or changes not yet present in the official nightly still
need reconciliation. The last published release remains available meanwhile.

Start a fix branch from this fork's `personal-nightly` branch. After testing,
merge it back into `personal-nightly`, or cherry-pick the tested commits there.
Direct commits are included automatically and stay separate from the refreshed
PR imports; you do not need to add them to `personal-nightly.json`. Use clear commit titles: they become the personal entries
in the release notes.

When a build detects newer direct fixes before publishing, it skips publication
without a failure alert. The last published release stays available, and the next
eligible check rebuilds with your fix.

Run **Actions → Personal nightly → Run workflow** on `personal-nightly` and select
**force** to bypass the debounce and cooldown when an immediate build is needed.
Otherwise, wait for the next eligible scheduled check. The existing update controls
offer the release after its checks and builds pass.

Each changelog combines the official nightly notes since the previous successful
personal release with your new commits. It includes official nightlies skipped
between personal builds. The first personal release lists the latest official
nightly's changes and the personal fixes it already contains. The update popup
shows a short summary; its GitHub link opens the full combined changelog.
