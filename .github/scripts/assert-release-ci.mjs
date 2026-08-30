import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export async function assertReleaseCi({
  sha,
  repository,
  token,
  branch = 'main',
  fetchImpl = globalThis.fetch,
}) {
  if (!SHA_PATTERN.test(sha ?? '')) {
    throw new Error(`RELEASE_SHA must be a 40-character commit SHA, received ${sha ?? '(unset)'}`);
  }
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const url = `https://api.github.com/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`;
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub Actions API returned ${response.status}`);

  const payload = await response.json();
  const matching = (payload.workflow_runs ?? []).filter(
    (run) =>
      run.path === '.github/workflows/ci.yml' &&
      run.head_sha === sha &&
      run.event === 'push' &&
      run.head_branch === branch,
  );
  const successful = matching.find(
    (run) => run.status === 'completed' && run.conclusion === 'success',
  );
  if (!successful) {
    const state = matching.map((run) => `${run.id}:${run.status}/${run.conclusion}`).join(', ');
    throw new Error(`no successful CI run found for ${sha}${state ? ` (${state})` : ''}`);
  }
  return successful;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const run = await assertReleaseCi({
      sha: process.env.RELEASE_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      branch: process.env.RELEASE_BRANCH ?? 'main',
    });
    process.stdout.write(`ok CI run ${run.id} passed for ${run.head_sha}\n`);
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
