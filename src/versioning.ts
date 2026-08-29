// versioning.ts — semver for page revisions.
//
// The block-diff half stays in the app: it has to walk a block tree, and every
// project owns its own type set. What travels is the version arithmetic and the
// rule for choosing a bump, which had drifted into a per-repo string split.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type ChangeType = 'major' | 'minor' | 'patch' | 'none';

/** Tolerant of null, empty and malformed input — a page always has a version. */
export function parseVersion(version: string | null | undefined): SemVer {
  if (!version) return { major: 1, minor: 0, patch: 0 };
  const [major = 1, minor = 0, patch = 0] = version.split('.').map(Number);
  return {
    major: Number.isFinite(major) && major ? major : 1,
    minor: Number.isFinite(minor) ? minor : 0,
    patch: Number.isFinite(patch) ? patch : 0,
  };
}

export function formatVersion(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function incrementVersion(version: SemVer, changeType: ChangeType): SemVer {
  switch (changeType) {
    case 'major':
      return { major: version.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { ...version, minor: version.minor + 1, patch: 0 };
    case 'patch':
      return { ...version, patch: version.patch + 1 };
    default:
      return version;
  }
}

/** Bump a version string in one step — the call site almost always wants this. */
export function bump(version: string | null | undefined, changeType: ChangeType): string {
  return formatVersion(incrementVersion(parseVersion(version), changeType));
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}
