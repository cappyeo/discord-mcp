import { execFile as nodeExecFile } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const NPM_PROVENANCE_SCHEMA = 'discord-mcp.npm-provenance.v1';
export const NPM_AUDIT_TIMEOUT_MS = 120_000;
export const NPM_FETCH_TIMEOUT_MS = 15_000;
export const NPM_MAX_JSON_BYTES = 2 * 1024 * 1024;
export const NPM_MAX_LOCKFILE_BYTES = 4 * 1024 * 1024;
export const NPM_REGISTRY_HOST = 'registry.npmjs.org';
export const NPM_REGISTRY_URL = `https://${NPM_REGISTRY_HOST}/`;
export const EXPECTED_SOURCE_REPOSITORY = 'github.com/cappyeo/discord-mcp';

const NPM_CLI_MAX_BYTES = 1024 * 1024;

const COMMIT_RE = /^[a-f0-9]{40}$/;
const RELEASE_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_URL_LENGTH = 2048;

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPackageInput(packageName, release, expectedCommit) {
  if (typeof packageName !== 'string' || !PACKAGE_RE.test(packageName))
    throw new TypeError('packageName is invalid');
  if (typeof release !== 'string' || !RELEASE_RE.test(release))
    throw new TypeError('release is invalid');
  if (typeof expectedCommit !== 'string' || !COMMIT_RE.test(expectedCommit))
    throw new TypeError('expectedCommit must be a full lowercase Git commit SHA');
}

function assertInstallRoot(installRoot) {
  if (typeof installRoot !== 'string' || installRoot.length === 0) {
    throw new TypeError('installRoot is required');
  }
  return installRoot;
}

function isCredentialKey(key) {
  return (
    /(?:^|[_-])(?:token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key)(?:$|[_-])/i.test(
      key,
    ) || /^(?:OPENAI|ANTHROPIC|CLAUDE|GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)/i.test(key)
  );
}

const SAFE_ENV_NAMES = new Set([
  'systemroot',
  'temp',
  'tmp',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
  'npm_config_cache',
]);

function platformPath(platform) {
  return platform === 'win32' ? win32 : posix;
}

function proxyHasCredentials(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/** Return only the process settings needed by a registry-only npm subprocess. */
export function createNpmAuditEnvironment({
  env = process.env,
  nodeExecPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (env === null || typeof env !== 'object' || Array.isArray(env))
    throw new TypeError('env must be an object');
  const paths = platformPath(platform);
  if (typeof nodeExecPath !== 'string' || !paths.isAbsolute(nodeExecPath))
    throw new TypeError('nodeExecPath must be absolute');
  const safe = {};
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (!SAFE_ENV_NAMES.has(lower) || isCredentialKey(key) || typeof value !== 'string') continue;
    if (
      (lower.includes('proxy') || lower === 'http_proxy' || lower === 'https_proxy') &&
      proxyHasCredentials(value)
    )
      continue;
    // Keep the caller's spelling (Path is significant on Windows) while making
    // the allowlist decision case-insensitive.
    safe[key] = value;
  }
  // npm is invoked through the absolute Node executable, never a shell. Keep
  // the child lookup path deterministic so caller PATH/ComSpec cannot select a
  // different npm, node, or command shim.
  safe[platform === 'win32' ? 'Path' : 'PATH'] = paths.dirname(nodeExecPath);
  return safe;
}

function samePath(left, right, platform) {
  const paths = platformPath(platform);
  const normalizedLeft = paths.normalize(left);
  const normalizedRight = paths.normalize(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Resolve npm only from fixed locations belonging to the active Node install. */
export async function resolveTrustedNpmCli({
  execPath = process.execPath,
  platform = process.platform,
  lstat = fs.lstat,
  realpath = fs.realpath,
} = {}) {
  const paths = platformPath(platform);
  if (typeof execPath !== 'string' || !paths.isAbsolute(execPath))
    throw new TypeError('execPath must be absolute');
  const realExecutable = await realpath(execPath);
  const nodeDirectory = paths.dirname(realExecutable);
  const candidates =
    platform === 'win32'
      ? [paths.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          paths.join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          paths.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          paths.join(nodeDirectory, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
        ];
  for (const candidate of candidates) {
    try {
      const stat = await lstat(candidate);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > NPM_CLI_MAX_BYTES
      )
        continue;
      const canonical = await realpath(candidate);
      if (!samePath(canonical, paths.resolve(candidate), platform)) continue;
      return canonical;
    } catch {
      // Try only the next location derived from the same Node installation.
    }
  }
  throw new Error('trusted npm CLI is unavailable beside the active Node executable');
}

function commandResult(result) {
  if (!record(result)) throw new Error('npm command returned no result');
  const code = Number.isInteger(result.code)
    ? result.code
    : Number.isInteger(result.status)
      ? result.status
      : Number.isInteger(result.exitCode)
        ? result.exitCode
        : 0;
  return { code, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

async function runNpmAudit({
  installRoot,
  runCommand,
  platform,
  env,
  signal,
  nodeExecPath,
  resolveNpmCli,
}) {
  const npmCliPath = await resolveNpmCli({ execPath: nodeExecPath, platform });
  const options = {
    cwd: installRoot,
    env: createNpmAuditEnvironment({ env, nodeExecPath, platform }),
    encoding: 'utf8',
    timeout: NPM_AUDIT_TIMEOUT_MS,
    maxBuffer: NPM_MAX_JSON_BYTES,
    windowsHide: true,
    signal,
  };
  let result;
  try {
    const args = [npmCliPath, 'audit', 'signatures', '--json', `--registry=${NPM_REGISTRY_URL}`];
    if (runCommand) {
      result = await runCommand(nodeExecPath, args, options);
    } else {
      const completed = await execFile(nodeExecPath, args, options);
      result = { code: 0, stdout: completed.stdout, stderr: completed.stderr };
    }
  } catch (error) {
    const code = Number.isInteger(error?.code) ? error.code : 1;
    result = { code, stdout: error?.stdout, stderr: error?.stderr };
  }
  const normalized = commandResult(result);
  if (normalized.code !== 0) throw new Error('npm audit signatures exited unsuccessfully');
  if (Buffer.byteLength(normalized.stdout, 'utf8') > NPM_MAX_JSON_BYTES)
    throw new Error('npm audit signatures output exceeds the size bound');
  let parsed;
  try {
    parsed = JSON.parse(normalized.stdout);
  } catch {
    throw new Error('npm audit signatures returned invalid JSON');
  }
  if (!record(parsed) || !Array.isArray(parsed.invalid) || !Array.isArray(parsed.missing))
    throw new Error('npm audit signatures returned incomplete results');
  if (parsed.invalid.length !== 0 || parsed.missing.length !== 0)
    throw new Error('npm audit signatures reported missing or invalid signatures');
}

function packageMetadataUrl(packageName) {
  return `https://${NPM_REGISTRY_HOST}/${encodeURIComponent(packageName)}`;
}

function boundedRegistryUrl(value, packageName, release) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH)
    throw new Error('npm attestation URL is invalid');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('npm attestation URL is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== NPM_REGISTRY_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname.length > 1536
  ) {
    throw new Error('npm attestation URL is outside the registry boundary');
  }
  const decoded = decodeURIComponent(parsed.pathname);
  if (!decoded.includes(`${packageName}@${release}`))
    throw new Error('npm attestation URL does not identify the requested package version');
  return parsed.href;
}

function npmPurl(packageName, release) {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.slice(1).split('/');
    return `pkg:npm/%40${scope}/${name}@${release}`;
  }
  return `pkg:npm/${packageName}@${release}`;
}

function canonicalBase64(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64_RE.test(value)
  )
    throw new Error(`${label} is malformed`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value)
    throw new Error(`${label} is malformed`);
  return bytes;
}

function decodeJsonPayload(value) {
  const bytes = canonicalBase64(value, 'DSSE payload');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('DSSE payload is not valid JSON');
  }
  if (!record(parsed)) throw new Error('DSSE payload is not a JSON object');
  return parsed;
}

function resolveIntegrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(value))
    throw new Error('package registry integrity is missing or unsupported');
  const encoded = value.slice('sha512-'.length);
  const bytes = canonicalBase64(encoded, 'registry integrity');
  if (bytes.length !== 64) throw new Error('registry integrity is not sha512');
  return { canonical: `sha512-${encoded}`, base64: encoded, hex: bytes.toString('hex') };
}

async function readPackageLock(installRoot) {
  const path = join(installRoot, 'package-lock.json');
  let initial;
  try {
    initial = await fs.lstat(path);
  } catch {
    throw new Error('installed package lock is unavailable');
  }
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > NPM_MAX_LOCKFILE_BYTES)
    throw new Error('installed package lock is invalid');
  let handle;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== initial.size ||
      before.dev !== initial.dev ||
      before.ino !== initial.ino
    )
      throw new Error('installed package lock changed during read');
    const contents = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      Buffer.byteLength(contents, 'utf8') !== before.size
    )
      throw new Error('installed package lock changed during read');
    try {
      return JSON.parse(contents);
    } catch {
      throw new Error('installed package lock is invalid JSON');
    }
  } finally {
    await handle?.close();
  }
}

function assertPackageLockBinding(lockfile, packageName, release, registryIntegrity) {
  const entry =
    record(lockfile) && record(lockfile.packages)
      ? lockfile.packages[`node_modules/${packageName}`]
      : undefined;
  if (!record(entry) || entry.version !== release)
    throw new Error('installed package lock does not contain the requested release');
  if (resolveIntegrity(entry.integrity).canonical !== registryIntegrity.canonical)
    throw new Error('installed package lock does not match official registry integrity');
}

function subjectDigestMatches(value, integrity) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !Object.hasOwn(value, 'sha512')) return false;
  const digest = value.sha512;
  if (typeof digest !== 'string') return false;
  if (digest === integrity.base64) return true;
  if (/^[a-f0-9]{128}$/.test(digest)) return digest === integrity.hex;
  if (digest.startsWith('sha512-')) {
    try {
      return resolveIntegrity(digest).canonical === integrity.canonical;
    } catch {
      return false;
    }
  }
  return false;
}

function sourceDependencyMatches(value, expectedCommit) {
  if (!record(value) || typeof value.uri !== 'string' || !record(value.digest)) return false;
  const uri = value.uri;
  const repoPattern = new RegExp(
    `^(?:git\\+)?https://${EXPECTED_SOURCE_REPOSITORY.replaceAll('.', '\\.')}(?:\\.git)?(?:[@#](.+))?$`,
  );
  const match = repoPattern.exec(uri);
  if (!match || Object.keys(value.digest).length !== 1 || value.digest.gitCommit !== expectedCommit)
    return false;
  // GitHub Actions provenance normally records the workflow ref in the URI
  // and binds the immutable commit in digest.gitCommit. If the URI itself is
  // a raw commit, bind that too; a different ref remains harmlessly checked by
  // the digest below.
  return match[1] === undefined || !/^[a-f0-9]{40}$/.test(match[1]) || match[1] === expectedCommit;
}

function parseAttestation(response, packageName, release, integrity, expectedCommit) {
  if (!record(response) || !Array.isArray(response.attestations))
    throw new Error('npm attestation response is missing or ambiguous');
  const candidates = response.attestations.filter(
    (item) => record(item) && item.predicateType === 'https://slsa.dev/provenance/v1',
  );
  if (candidates.length !== 1) throw new Error('npm attestation response is missing or ambiguous');
  const item = candidates[0];
  if (
    !record(item) ||
    item.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !record(item.bundle)
  )
    throw new Error('npm attestation is not a single SLSA v1 statement');
  const envelope = item.bundle.dsseEnvelope;
  if (
    !record(envelope) ||
    typeof envelope.payload !== 'string' ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0
  )
    throw new Error('npm attestation DSSE envelope is incomplete');
  if (envelope.payloadType !== 'application/vnd.in-toto+json')
    throw new Error('npm attestation DSSE payload type is unsupported');
  const statement = decodeJsonPayload(envelope.payload);
  if (
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    !record(statement.subject[0]) ||
    statement.subject[0].name !== npmPurl(packageName, release) ||
    !subjectDigestMatches(statement.subject[0].digest, integrity)
  ) {
    throw new Error('npm attestation subject does not match the requested package artifact');
  }
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
  if (!Array.isArray(dependencies)) throw new Error('npm attestation has no resolved dependencies');
  const matches = dependencies.filter((dependency) =>
    sourceDependencyMatches(dependency, expectedCommit),
  );
  if (matches.length !== 1)
    throw new Error('npm attestation source dependency is missing or ambiguous');
  const sourceCommit = matches[0].digest.gitCommit;
  if (sourceCommit !== expectedCommit) throw new Error('npm attestation source commit mismatch');
  return sourceCommit;
}

async function defaultFetchJson(url, { signal } = {}) {
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) throw new Error('npm registry request failed');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > NPM_MAX_JSON_BYTES)
    throw new Error('npm registry response is too large');
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > NPM_MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error('npm registry response is too large');
    }
    chunks.push(part.value);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    throw new Error('npm registry returned invalid JSON');
  }
  return parsed;
}

async function fetchBoundedJson(fetchJson, url, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT_MS);
  try {
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const value = await fetchJson(url, { signal: requestSignal, maxBytes: NPM_MAX_JSON_BYTES });
    if (!record(value)) throw new Error('npm registry returned invalid JSON');
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > NPM_MAX_JSON_BYTES)
      throw new Error('npm registry response is too large');
    return value;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('npm registry request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify that an installed public npm release has npm's verified provenance
 * binding to the expected source commit. npm audit performs signature and
 * Sigstore verification; this module only parses and binds its result.
 */
export async function verifyInstalledNpmProvenance({
  installRoot,
  packageName = '@discord-mcp/cli',
  release,
  expectedCommit,
  runCommand,
  fetchJson = defaultFetchJson,
  platform = process.platform,
  env = process.env,
  signal,
  readLockfile = readPackageLock,
  nodeExecPath = process.execPath,
  resolveNpmCli = resolveTrustedNpmCli,
} = {}) {
  assertInstallRoot(installRoot);
  assertPackageInput(packageName, release, expectedCommit);
  if (runCommand !== undefined && typeof runCommand !== 'function')
    throw new TypeError('runCommand must be a function');
  if (typeof fetchJson !== 'function') throw new TypeError('fetchJson must be a function');
  if (typeof readLockfile !== 'function') throw new TypeError('readLockfile must be a function');
  if (typeof resolveNpmCli !== 'function') throw new TypeError('resolveNpmCli must be a function');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('signal must be an AbortSignal');
  await runNpmAudit({
    installRoot,
    runCommand,
    platform,
    env,
    signal,
    nodeExecPath,
    resolveNpmCli,
  });

  const metadata = await fetchBoundedJson(fetchJson, packageMetadataUrl(packageName), signal);
  if (
    metadata.name !== packageName ||
    !record(metadata.versions) ||
    !record(metadata.versions[release])
  )
    throw new Error('npm registry metadata does not contain the requested package version');
  const dist = metadata.versions[release].dist;
  if (!record(dist)) throw new Error('npm registry distribution metadata is missing');
  const integrity = resolveIntegrity(dist.integrity);
  signal?.throwIfAborted();
  assertPackageLockBinding(await readLockfile(installRoot), packageName, release, integrity);
  if (!record(dist.attestations)) throw new Error('npm registry attestation metadata is missing');
  const attestationUrl = boundedRegistryUrl(dist.attestations.url, packageName, release);
  const attestations = await fetchBoundedJson(fetchJson, attestationUrl, signal);
  const sourceCommit = parseAttestation(
    attestations,
    packageName,
    release,
    integrity,
    expectedCommit,
  );
  return { sourceCommit, registryIntegrityDigest: integrity.canonical };
}

export const __private = {
  assertPackageLockBinding,
  boundedRegistryUrl,
  createNpmAuditEnvironment,
  npmPurl,
  parseAttestation,
  resolveTrustedNpmCli,
  resolveIntegrity,
};
