/**
 * `node-version` check — Plan 9 Phase B.
 *
 * Verifies the running Node.js >= 22.12.0. The package.json `engines.node`
 * field declares `">=22.12"` (Node 22 LTS minimum, and the lowest version
 * CI verifies). We enforce this at runtime via
 * doctor so users get a clear actionable error instead of a cryptic
 * import or syntax failure later.
 *
 * Implementation reads `process.versions.node` (e.g. "22.12.1") and
 * does a manual semver compare on the major/minor/patch tuple — we
 * don't pull in the `semver` package because that would violate the
 * "no new runtime deps" rule for Phase B.
 */
import type { DoctorCheck } from './index.js';

const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 12;
const REQUIRED_PATCH = 0;

function parseNodeVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (m === null) {
    return null;
  }
  // Coerce via Number() — the regex group already constrains to digits,
  // so NaN is impossible. Coalesce-or-throw belt-and-braces is overkill.
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function meetsRequirement(parsed: [number, number, number]): boolean {
  const [major, minor, patch] = parsed;
  if (major > REQUIRED_MAJOR) {
    return true;
  }
  if (major < REQUIRED_MAJOR) {
    return false;
  }
  // Same major.
  if (minor > REQUIRED_MINOR) {
    return true;
  }
  if (minor < REQUIRED_MINOR) {
    return false;
  }
  // Same major.minor.
  return patch >= REQUIRED_PATCH;
}

export const nodeVersionCheck: DoctorCheck = {
  id: 'node-version',
  description: 'Node.js >= 22.12',
  online: false,
  async run() {
    const running = process.versions.node;
    const parsed = parseNodeVersion(running);
    const required = `>=${REQUIRED_MAJOR}.${REQUIRED_MINOR}.${REQUIRED_PATCH}`;

    if (parsed === null) {
      return {
        id: 'node-version',
        status: 'fail',
        message: `Could not parse Node.js version "${running}"`,
        details: { running, required },
      };
    }

    if (meetsRequirement(parsed)) {
      return {
        id: 'node-version',
        status: 'ok',
        message: `Node.js ${running} satisfies ${required}`,
        details: { running, required },
      };
    }

    return {
      id: 'node-version',
      status: 'fail',
      message: `Node.js ${running} is older than ${required}`,
      details: { running, required },
    };
  },
};
