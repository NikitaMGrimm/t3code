# Personal nightly updates

This fork combines the official nightly with the personal changes on
`personal-nightly`. Updates use the existing T3 Code update and restart controls.
If a nightly has merge conflicts or fails its checks, the current build stays
available. The sidebar and Settings → General → About show the stopped update
and link to its details.

Install a release from [this fork](https://github.com/NikitaMGrimm/t3code/releases)
once before using its updater. An official T3 Code installation follows the
official release feed until replaced with a personal build. Keep the update track
on Nightly. Windows releases also include the matching Linux runtime for WSL.

For a standalone WSL or Linux server, run this fork's `scripts/install.sh`, then
use `t3 service install` for app-controlled server updates. It checks the release
checksum and retains versioned runtimes. The personal VPS uses its existing
deployment coordinator so the app can update its managed container safely.

The Personal nightly GitHub workflow checks for an official nightly every four
hours and can be run manually. To activate it, publish the `personal-nightly`
branch, make it the fork's default branch, and disable the fork's original Release
workflow. Add the Actions secret `PERSONAL_NIGHTLY_TOKEN`: a fine-grained GitHub
token restricted to this fork with Contents and Workflows write permissions. It
is needed to merge upstream workflow changes. The workflow publishes only after
the focused checks and Windows/Linux x64/arm64 builds pass. An unchanged published
head repairs the status feed without rebuilding.

## Adding your own fixes

Start a fix branch from this fork's `personal-nightly` branch. After testing,
merge it back into `personal-nightly`, or cherry-pick the tested commits there.
Direct commits are included automatically; you do not need to add them to
`personal-nightly.json`. Use clear commit titles: they become the personal entries
in the release notes.

Run **Actions → Personal nightly → Run workflow** on `personal-nightly` to build
immediately, or wait for the next four-hour check. The existing update controls
offer the release after its checks and builds pass.

Each changelog combines the official nightly notes since the previous successful
personal release with your new commits. It includes official nightlies skipped
between personal builds. The first personal release lists the latest official
nightly's changes and the personal fixes it already contains. The update popup
shows a short summary; its GitHub link opens the full combined changelog.
