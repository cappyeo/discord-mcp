import { createActivationLiveAdapter } from './activation-live-adapter.mjs';
import { buildCodexEnvironment, resolveCodexLauncher } from './small-model-eval.mjs';
import {
  buildSmallModelLiveArguments,
  classifySmallModelLiveInitial,
  classifySmallModelLiveResume,
  parseSmallModelLiveJsonl,
  preparePrivateCodexHome,
  runBoundedCodexProcess,
  SMALL_MODEL_LIVE_REQUEST,
} from './small-model-live-eval.mjs';

const HOST_VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;

export function createCodexActivationLiveAdapter(options = {}) {
  const {
    resolveLauncher = resolveCodexLauncher,
    runProcess = runBoundedCodexProcess,
    prepareCodexHome = preparePrivateCodexHome,
    ...common
  } = options;
  return createActivationLiveAdapter({
    ...common,
    hostDriver: {
      id: 'codex',
      label: 'Codex',
      processDidNotCloseCode: 'CODEX_PROCESS_DID_NOT_CLOSE',
      initialTool: 'build_discord_server',
      applyTool: 'guild_blueprint_apply',
      evidenceTool: 'guild_blueprint_evidence',
      initialQualifiedTool: 'build_discord_server',
      applyQualifiedTool: 'guild_blueprint_apply',
      evidenceQualifiedTool: 'guild_blueprint_evidence',
      sessionField: 'threadId',
      sessionSchema: 'discord-mcp.codex-activation-session.v1',
      initialRequest: SMALL_MODEL_LIVE_REQUEST,
      buildEnvironment: buildCodexEnvironment,
      buildArguments: buildSmallModelLiveArguments,
      parseJsonl: parseSmallModelLiveJsonl,
      classifyInitial: classifySmallModelLiveInitial,
      classifyResume: (...args) => {
        const classification = classifySmallModelLiveResume(...args);
        return classification === 'resume_required' ? 'pass' : classification;
      },
      contractErrors: (parsed) => parsed.contract_errors,
      preparePrivateState: prepareCodexHome,
      privateEnvironment: (privateHome) => ({ CODEX_HOME: privateHome.path }),
      resolveLauncher,
      runProcess,
      parseVersion: (stdout) => HOST_VERSION.exec(stdout)?.[1] ?? null,
      sessionId: (parsed) => parsed.thread_id,
    },
  });
}
