import * as Schema from "effect/Schema";
import personalNightly from "../../../personal-nightly.json" with { type: "json" };
import { compareSemverVersions } from "./semver.ts";

export const PERSONAL_RELEASE_REPOSITORY = personalNightly.repository;
export const PERSONAL_UPDATE_STATUS_URL = `https://raw.githubusercontent.com/${PERSONAL_RELEASE_REPOSITORY}/personal-update-status/status.json`;
const NightlyVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/));

// An imported PR needs upstream files that the official nightly does not have yet.
const PersonalUpdateWait = Schema.Struct({
  pullRequest: Schema.Int.check(Schema.isGreaterThan(0)),
  baseCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  paths: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});

export const PersonalUpdateStatus = Schema.Struct({
  schema: Schema.Literal(1),
  sequence: Schema.optional(Schema.Int),
  phase: Schema.Literals(["building", "ready", "conflict", "failed"]),
  upstreamTag: Schema.String,
  conflicts: Schema.Array(Schema.String),
  // A workflow run, or the release page of a build published without one.
  runUrl: Schema.String.check(
    Schema.isPattern(
      /^https:\/\/github\.com\/NikitaMGrimm\/t3code\/(?:actions\/runs\/\d+|releases\/tag\/v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/,
    ),
  ),
  releasedVersion: Schema.NullOr(NightlyVersion),
  conflictIdentity: Schema.optional(Schema.String),
  waiting: Schema.optional(PersonalUpdateWait),
}).check(
  Schema.makeFilter(
    (status) =>
      status.waiting === undefined || status.phase === "ready" || status.phase === "building",
  ),
);
export type PersonalUpdateStatus = typeof PersonalUpdateStatus.Type;
export const decodePersonalUpdateStatus = Schema.decodeUnknownSync(PersonalUpdateStatus);

export function newerPersonalRelease(
  status: PersonalUpdateStatus | null,
  currentVersion: string | undefined,
): string | null {
  const version = status?.releasedVersion;
  return version && currentVersion && compareSemverVersions(version, currentVersion) > 0
    ? version
    : null;
}

export function personalUpdateMessage(status: PersonalUpdateStatus): string {
  if (status.waiting) {
    return `Waiting for an official nightly with the upstream changes #${status.waiting.pullRequest} needs. Your current build is kept.`;
  }
  switch (status.phase) {
    case "conflict":
      return `Nightly update has merge conflicts: ${status.conflicts.join(", ")}. Your current build is kept.`;
    case "failed":
      return "Nightly checks or packaging failed. Your current build is kept.";
    case "building":
      return "The next personal nightly is being checked and built.";
    case "ready":
      return `Personal nightly ${status.releasedVersion ?? "release"} passed its checks.`;
  }
}
