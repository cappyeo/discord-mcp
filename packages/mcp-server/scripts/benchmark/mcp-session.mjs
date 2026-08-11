import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const NORTH_STAR_TOOLS = [
  'guild_blueprint_plan',
  'guild_blueprint_apply',
  'guild_blueprint_evidence',
];
const ALLOWED_CHILD_ENV = new Set([
  'ALLOWED_GUILDS',
  'DISCORD_EXPECTED_BOT_ID',
  'DISCORD_TOKEN',
  'GATEWAY',
  'MCP_AUDIT_ENABLED',
  'MCP_BLUEPRINT_STATE_DIR',
  'MCP_DRY_RUN',
  'MCP_TOOL_SURFACE',
  'MCP_WRITE_MODE',
]);

function childEnvironment(overrides) {
  const unknown = Object.keys(overrides).filter((key) => !ALLOWED_CHILD_ENV.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`unsupported MCP child environment keys: ${unknown.sort().join(', ')}`);
  }
  return { ...getDefaultEnvironment(), ...overrides };
}

function sensitiveValues(env) {
  return Object.entries(env)
    .filter(
      ([key, value]) =>
        /(?:token|authorization|password|secret|cookie|credential|api[_-]?key)/i.test(key) &&
        typeof value === 'string' &&
        value !== '',
    )
    .map(([, value]) => value);
}

function redact(value, secrets) {
  return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
}

function sessionError(message, code = null) {
  const error = new Error(message);
  if (typeof code === 'string' && code !== '') error.code = code;
  return error;
}

async function closeQuietly(client, transport) {
  try {
    await client.close();
  } catch {
    try {
      await transport.close();
    } catch {
      // Preserve the primary benchmark error.
    }
  }
}

export async function openMcpBenchmarkSession({
  cliPath,
  cwd,
  env,
  requiredTools = NORTH_STAR_TOOLS,
}) {
  const secrets = sensitiveValues(env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'serve'],
    cwd,
    env: childEnvironment(env),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'discord-mcp-real-benchmark', version: '1.0.0' },
    { capabilities: {} },
  );
  let rawStderrTail = '';
  transport.stderr?.on('data', (chunk) => {
    rawStderrTail = `${rawStderrTail}${String(chunk)}`.slice(-16_384);
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    const missing = requiredTools.filter((name) => !toolNames.includes(name));
    if (missing.length > 0) {
      throw new Error(`missing required MCP tools: ${missing.join(', ')}`);
    }
    const pid = transport.pid;
    if (pid === null) throw new Error('MCP child process did not expose a pid');

    let closed = false;
    return {
      pid,
      toolNames,
      async callTool(name, args) {
        const result = await client.callTool({ name, arguments: args });
        const data = result.structuredContent;
        if (result.isError === true || data === undefined || data === null) {
          const code =
            data !== null && typeof data === 'object' && typeof data.code === 'string'
              ? data.code
              : 'MCP_TOOL_ERROR';
          throw sessionError(`${name} failed (${code})`, code);
        }
        return data;
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeQuietly(client, transport);
      },
    };
  } catch (error) {
    await closeQuietly(client, transport);
    const message = redact(error instanceof Error ? error.message : error, secrets);
    if (message.startsWith('missing required MCP tools:')) throw error;
    const stderrTail = redact(rawStderrTail, secrets).slice(-8_192);
    throw sessionError(
      `${message}${stderrTail.trim() === '' ? '' : `; child stderr: ${stderrTail.trim()}`}`,
      error?.code,
    );
  }
}
