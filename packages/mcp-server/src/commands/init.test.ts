/**
 * Integration-ish tests for `initAction` - Plan 9 Phase D.
 *
 * The non-interactive paths are exercised here. Interactive prompts
 * are tested in `lib/prompt.test.ts` against mocked readline; this
 * file forces non-interactive (TTY=false) so the action follows the
 * deterministic flag-only branch.
 *
 * `node:fs` is partially mocked: `existsSync` and `writeFileSync` are
 * driven per-test via small in-memory shims so we don't need real
 * temp files. Read paths still hit the real fs (none used here).
 */
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked fs - set per-test by reassigning the impl variables. Default
// is a clean filesystem (existsSync → false, writeFileSync → no-op).
let existsImpl: (path: string) => boolean = () => false;
let writeImpl: (path: string, data: string) => void = () => undefined;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: ((p: string) => existsImpl(p)) as typeof actual.existsSync,
    writeFileSync: ((p: string, data: string) => writeImpl(p, data)) as typeof actual.writeFileSync,
  };
});

const { initAction, resolveCliPath } = await import('./init.js');

const originalStdinTTY = process.stdin.isTTY;
const originalStdoutTTY = process.stdout.isTTY;
const originalExitCode = process.exitCode;

let stdoutWrites: string[] = [];

beforeEach(() => {
  existsImpl = () => false;
  writeImpl = () => undefined;
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  // Force non-interactive so the action takes the flag-only branch.
  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
    writable: true,
  });
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalStdinTTY,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalStdoutTTY,
    configurable: true,
    writable: true,
  });
  process.exitCode = originalExitCode;
});

function stdoutOutput(): string {
  return stdoutWrites.join('');
}

interface InitJsonResult {
  ok: boolean;
  exitCode: number;
  summary: string;
  data?: {
    client?: string;
    configFilePath?: string;
    content?: string;
    instructions?: string;
    gateway?: boolean;
  };
}

interface ParsedSnippet {
  mcpServers: {
    'discord-mcp': {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
}

describe('resolveCliPath', () => {
  // `import.meta.url` of a real checkout can't contain the interesting
  // characters, so these drive the resolver with synthetic module URLs.
  const SPACED_MODULE_URL = 'file:///C:/Users/n%C3%B6el%20user/discord-mcp/commands/init.js';

  it('decodes percent-encoded spaces and non-ASCII segments', () => {
    const p = resolveCliPath(SPACED_MODULE_URL);
    expect(p).not.toContain('%');
    expect(p).toContain('nöel user');
  });

  it('resolves to the cli.js sibling of commands/', () => {
    const p = resolveCliPath(SPACED_MODULE_URL);
    expect(p.endsWith(`${nodePath.sep}cli.js`)).toBe(true);
    expect(p).not.toContain('commands');
  });

  it('produces a native path the OS accepts verbatim', () => {
    // A URL pathname on Windows is `/C:/...` - absolute-looking but not a
    // real path; `path.resolve` rewrites it, so round-tripping catches it.
    const p = resolveCliPath('file:///C:/Program%20Files/discord-mcp/commands/init.js');
    expect(nodePath.resolve(p)).toBe(p);
  });
});

describe('initAction - non-interactive defaults', () => {
  it('with no flags defaults to client=generic and the env-var token placeholder', async () => {
    await initAction({ json: true });
    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.client).toBe('generic');
    const snippet = JSON.parse(parsed.data?.content ?? '{}') as ParsedSnippet;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder, not JS interpolation
    expect(snippet.mcpServers['discord-mcp'].env.DISCORD_TOKEN).toBe('${env:DISCORD_TOKEN}');
    expect(parsed.data?.gateway).toBe(false);
  });

  it('emits a spawnable native path as the first arg', async () => {
    await initAction({ json: true });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    const snippet = JSON.parse(parsed.data?.content ?? '{}') as ParsedSnippet;
    const cliArg = snippet.mcpServers['discord-mcp'].args[0] as string;
    expect(cliArg).not.toContain('%');
    expect(nodePath.resolve(cliArg)).toBe(cliArg);
  });

  it('summary mentions the displayName when generated to stdout', async () => {
    await initAction({ json: true });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.summary).toContain('Generic MCP client');
  });
});

describe('initAction - explicit flags', () => {
  it('with --client claude-desktop --token "Bot abc..." produces matching snippet', async () => {
    await initAction({ json: true, client: 'claude-desktop', token: 'Bot abc123' });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.data?.client).toBe('claude-desktop');
    const snippet = JSON.parse(parsed.data?.content ?? '{}') as ParsedSnippet;
    expect(snippet.mcpServers['discord-mcp'].env.DISCORD_TOKEN).toBe('Bot abc123');
  });

  it('with --client claude-code adopts that generator', async () => {
    await initAction({ json: true, client: 'claude-code', token: 'Bot xyz' });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.data?.client).toBe('claude-code');
    expect(parsed.data?.configFilePath).toContain('.claude.json');
  });

  it('with --client cursor adopts that generator', async () => {
    await initAction({ json: true, client: 'cursor', token: 'Bot xyz' });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.data?.client).toBe('cursor');
    expect(parsed.data?.configFilePath).toContain('.cursor/mcp.json');
  });

  it('with --gateway appends --gateway to args in the snippet', async () => {
    await initAction({ json: true, client: 'generic', gateway: true });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    const snippet = JSON.parse(parsed.data?.content ?? '{}') as ParsedSnippet;
    expect(snippet.mcpServers['discord-mcp'].args).toContain('--gateway');
    expect(parsed.data?.gateway).toBe(true);
  });

  it('without --gateway omits the flag from args', async () => {
    await initAction({ json: true, client: 'generic' });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    const snippet = JSON.parse(parsed.data?.content ?? '{}') as ParsedSnippet;
    expect(snippet.mcpServers['discord-mcp'].args).not.toContain('--gateway');
  });

  it('with empty --token "" collapses to the env-var placeholder', async () => {
    await initAction({ json: true, client: 'generic', token: '' });
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    const snippet = JSON.parse(parsed.data?.content ?? '{}') as ParsedSnippet;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder
    expect(snippet.mcpServers['discord-mcp'].env.DISCORD_TOKEN).toBe('${env:DISCORD_TOKEN}');
  });
});

describe('initAction - unknown client', () => {
  it('exits with code 2 and lists the available clients', async () => {
    await initAction({ json: true, client: 'no-such-client' });
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult & {
      errors?: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.summary).toContain('no-such-client');
    expect(parsed.errors?.[0]).toContain('claude-desktop');
    expect(parsed.errors?.[0]).toContain('generic');
  });
});

describe('initAction - --output file writing', () => {
  it('writes the snippet to --output and reports the path', async () => {
    let writtenPath: string | undefined;
    let writtenData: string | undefined;
    writeImpl = (p, d) => {
      writtenPath = p;
      writtenData = d;
    };

    await initAction({
      json: true,
      client: 'claude-desktop',
      token: 'Bot abc',
      output: 'C:/tmp/out.json',
    });
    expect(process.exitCode).toBe(0);
    expect(writtenPath).toBe('C:/tmp/out.json');
    expect(writtenData).toBeDefined();
    // The written content is parseable JSON.
    expect(() => JSON.parse(writtenData ?? '')).not.toThrow();
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.summary).toContain('C:/tmp/out.json');
  });

  it('refuses to overwrite an existing --output path without --force', async () => {
    existsImpl = () => true;
    let writeCalled = false;
    writeImpl = () => {
      writeCalled = true;
    };

    await initAction({
      json: true,
      client: 'generic',
      output: 'C:/tmp/exists.json',
    });
    expect(process.exitCode).toBe(2);
    expect(writeCalled).toBe(false);
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.ok).toBe(false);
    expect(parsed.summary).toContain('--force');
  });

  it('overwrites an existing --output path when --force is set', async () => {
    existsImpl = () => true;
    let writeCalled = false;
    writeImpl = () => {
      writeCalled = true;
    };

    await initAction({
      json: true,
      client: 'generic',
      output: 'C:/tmp/exists.json',
      force: true,
    });
    expect(process.exitCode).toBe(0);
    expect(writeCalled).toBe(true);
  });
});

describe('initAction - output formatting', () => {
  it('--json mode produces parseable structured output', async () => {
    await initAction({ json: true, client: 'generic' });
    expect(() => JSON.parse(stdoutOutput())).not.toThrow();
    const parsed = JSON.parse(stdoutOutput()) as InitJsonResult;
    expect(parsed.data?.content).toBeDefined();
    expect(parsed.data?.instructions).toBeDefined();
    expect(parsed.data?.configFilePath).toBeDefined();
  });

  it('pretty mode includes the snippet content under details when no --output', async () => {
    await initAction({ json: false, client: 'generic' });
    const out = stdoutOutput();
    expect(out).toContain('Snippet:');
    expect(out).toContain('mcpServers');
    expect(out).toContain('discord-mcp');
  });

  it('pretty mode omits the inline snippet body when --output is used', async () => {
    writeImpl = () => undefined;
    await initAction({ json: false, client: 'generic', output: 'C:/tmp/out.json' });
    const out = stdoutOutput();
    expect(out).toContain('wrote');
    expect(out).toContain('C:/tmp/out.json');
    // No "Snippet:" inline block when written to file.
    expect(out).not.toContain('Snippet:');
  });
});
