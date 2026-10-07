import * as Schema from "effect/Schema";
import personalNightly from "../../../personal-nightly.json" with { type: "json" };
import { compareSemverVersions } from "./semver.ts";

export const PERSONAL_RELEASE_REPOSITORY = personalNightly.repository;
export const PERSONAL_UPDATE_STATUS_URL = `https://raw.githubusercontent.com/${PERSONAL_RELEASE_REPOSITORY}/personal-update-status/status.json`;
const NightlyVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/));

export const PersonalUpdateStatus = Schema.Struct({
  schema: Schema.Literal(1),
  phase: Schema.Literals(["building", "ready", "conflict", "failed"]),
  upstreamTag: Schema.String,
  conflicts: Schema.Array(Schema.String),
  runUrl: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/NikitaMGrimm\/t3code\/actions\/runs\/\d+$/),
  ),
  releasedVersion: Schema.NullOr(NightlyVersion),
});
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
