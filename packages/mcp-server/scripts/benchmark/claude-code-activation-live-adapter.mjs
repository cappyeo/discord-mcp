import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { createActivationLiveAdapter } from './activation-live-adapter.mjs';
import {
  prepareClaudeCodePrivateState,
  resolveClaudeCodeLauncher,
  runBoundedClaudeCodeProcess,
  validateClaudeCodeMcpConfig,
} from './claude-code-driver.mjs';
import {
  buildClaudeCodeLiveArguments,
  CLAUDE_CODE_HOST,
  CLAUDE_CODE_TOOLS,
  classifyClaudeCodeInitial,
  classifyClaudeCodeResume,
  parseClaudeCodeLiveJsonl,
} from './claude-code-live-eval.mjs';

const HOST_VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u;
const DEFAULT_REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';

async function validateGuidedConfig({
  configPath,
  privateState,
  target,
  cliPath,
  nodePath,
  stateDirectory,
  mode,
} = {}) {
  if (typeof configPath !== 'string' || !isAbsolute(configPath))
    throw new TypeError('Claude guided configPath must be absolute');
  if (!privateState || typeof privateState.config !== 'object')
    throw new TypeError('Claude private config is unavailable');
  let guided;
  try {
    guided = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw new Error('Claude guided config could not be read');
  }
  validateClaudeCodeMcpConfig(guided, {
    nodePath,
    cliPath,
    target,
    stateDirectory,
    mode,
  });
  if (JSON.stringify(guided) !== JSON.stringify(privateState.config))
    throw new Error('Claude guided config does not equal the private canonical config');
}

/** Create the audited Claude Code host adapter over the generic activation lifecycle. */
export function createClaudeCodeActivationLiveAdapter(options = {}) {
  const {
    resolveLauncher = resolveClaudeCodeLauncher,
    runProcess = runBoundedClaudeCodeProcess,
    preparePrivateState = prepareClaudeCodePrivateState,
    nodePath = process.execPath,
    initialRequest = DEFAULT_REQUEST,
    ...common
  } = options;
  return createActivationLiveAdapter({
    ...common,
    hostDriver: {
      id: CLAUDE_CODE_HOST,
      label: 'Claude Code',
      processDidNotCloseCode: 'CLAUDE_CODE_PROCESS_DID_NOT_CLOSE',
      initialTool: 'build_discord_server',
      applyTool: 'guild_blueprint_apply',
      evidenceTool: 'guild_blueprint_evidence',
      initialQualifiedTool: CLAUDE_CODE_TOOLS.initial,
      applyQualifiedTool: CLAUDE_CODE_TOOLS.apply,
      evidenceQualifiedTool: CLAUDE_CODE_TOOLS.evidence,
      sessionField: 'sessionId',
      sessionSchema: 'discord-mcp.claude-code-activation-session.v1',
      initialRequest,
      mode: 'allow',
      nodePath,
      buildEnvironment: () => ({}),
      buildArguments: buildClaudeCodeLiveArguments,
      parseJsonl: parseClaudeCodeLiveJsonl,
      classifyInitial: classifyClaudeCodeInitial,
      classifyResume: classifyClaudeCodeResume,
      contractErrors: () => [],
      preparePrivateState,
      privateEnvironment: (privateState) => privateState.environment,
      childEnvironment: (privateState) => privateState.environment,
      validateGuidedConfig,
      resolveLauncher,
      runProcess,
      parseVersion: (stdout) => HOST_VERSION.exec(stdout)?.[1] ?? null,
      versionFromParsed: (parsed) => parsed.host_version,
      sessionId: (parsed) => parsed.session_id,
    },
  });
}
