import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function assertReleaseRef({ tag, cwd = process.cwd(), gitImpl = git }) {
  if (!TAG_PATTERN.test(tag ?? '')) {
    throw new Error(`RELEASE_TAG must be a semantic version tag, received ${tag ?? '(unset)'}`);
  }

  const headSha = gitImpl(['rev-parse', 'HEAD'], cwd);
  let tagSha;
  try {
    tagSha = gitImpl(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], cwd);
  } catch {
    throw new Error(`release tag ${tag} is missing`);
  }
  if (tagSha !== headSha) {
    throw new Error(`release tag ${tag} resolves to ${tagSha}, but checkout is ${headSha}`);
  }
  return { tag, sha: headSha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assertReleaseRef({ tag: process.env.RELEASE_TAG });
    process.stdout.write(`ok ${result.tag} resolves to ${result.sha}\n`);
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
