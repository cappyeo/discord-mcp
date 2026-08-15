import { createActivationLiveAdapter } from './activation-live-adapter.mjs';
import {
  prepareAntigravityPrivateState,
  resolveAntigravityLauncher,
  runBoundedAntigravityProcess,
} from './antigravity-cli-driver.mjs';
import {
  ANTIGRAVITY_CLI_HOST,
  ANTIGRAVITY_CLI_LIFECYCLE_TOOLS,
  buildAntigravityLiveArguments,
  classifyAntigravityInitial,
  classifyAntigravityResume,
  parseAntigravityLiveJsonl,
} from './antigravity-cli-live-eval.mjs';

const HOST_VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u;
const DEFAULT_REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';

/** Create the audited Antigravity CLI adapter over the host-neutral activation lifecycle. */
export function createAntigravityCliActivationLiveAdapter(options = {}) {
  const {
    resolveLauncher = resolveAntigravityLauncher,
    runProcess = runBoundedAntigravityProcess,
    preparePrivateState = prepareAntigravityPrivateState,
    nodePath = process.execPath,
    initialRequest = DEFAULT_REQUEST,
    ...common
  } = options;
  return createActivationLiveAdapter({
    ...common,
    hostDriver: {
      id: ANTIGRAVITY_CLI_HOST,
      label: 'Antigravity CLI',
      processDidNotCloseCode: 'ANTIGRAVITY_CLI_PROCESS_DID_NOT_CLOSE',
      initialTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      applyTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
      evidenceTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.evidence,
      initialQualifiedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      applyQualifiedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
      evidenceQualifiedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.evidence,
      sessionField: 'conversationId',
      sessionSchema: 'discord-mcp.antigravity-cli-activation-session.v1',
      initialRequest,
      mode: 'allow',
      nodePath,
      buildEnvironment: () => ({}),
      buildArguments: buildAntigravityLiveArguments,
      parseJsonl: parseAntigravityLiveJsonl,
      classifyInitial: classifyAntigravityInitial,
      classifyResume: classifyAntigravityResume,
      contractErrors: () => [],
      preparePrivateState,
      privateEnvironment: (privateState) => privateState.environment,
      childEnvironment: (privateState) => privateState.environment,
      resolveLauncher,
      runProcess,
      parseVersion: (stdout) => HOST_VERSION.exec(stdout)?.[1] ?? null,
      sessionId: (parsed) => parsed.conversation_id,
    },
  });
}
