import { createActivationLiveAdapter } from './activation-live-adapter.mjs';
import {
  prepareGrokCliPrivateState,
  resolveGrokCliLauncher,
  runBoundedGrokCliProcess,
} from './grok-cli-driver.mjs';
import {
  buildGrokCliLiveArguments,
  classifyGrokCliInitial,
  classifyGrokCliResume,
  GROK_CLI_HOST,
  GROK_CLI_LIFECYCLE_TOOLS,
  GROK_CLI_QUALIFIED_TOOLS,
  parseGrokCliLiveJsonl,
} from './grok-cli-live-eval.mjs';

const HOST_VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u;
const DEFAULT_REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';

/** Create the audited Grok CLI adapter over the host-neutral activation lifecycle. */
export function createGrokCliActivationLiveAdapter(options = {}) {
  const {
    resolveLauncher = resolveGrokCliLauncher,
    runProcess = runBoundedGrokCliProcess,
    preparePrivateState = prepareGrokCliPrivateState,
    initialRequest = DEFAULT_REQUEST,
    ...common
  } = options;
  return createActivationLiveAdapter({
    ...common,
    hostDriver: {
      id: GROK_CLI_HOST,
      label: 'Grok Build CLI',
      processDidNotCloseCode: 'GROK_CLI_PROCESS_DID_NOT_CLOSE',
      initialTool: GROK_CLI_LIFECYCLE_TOOLS.initial,
      applyTool: GROK_CLI_LIFECYCLE_TOOLS.apply,
      evidenceTool: GROK_CLI_LIFECYCLE_TOOLS.evidence,
      initialQualifiedTool: GROK_CLI_QUALIFIED_TOOLS.initial,
      applyQualifiedTool: GROK_CLI_QUALIFIED_TOOLS.apply,
      evidenceQualifiedTool: GROK_CLI_QUALIFIED_TOOLS.evidence,
      sessionField: 'grokSessionId',
      sessionSchema: 'discord-mcp.grok-cli-activation-session.v1',
      initialRequest,
      mode: 'allow',
      buildEnvironment: () => ({}),
      buildArguments: buildGrokCliLiveArguments,
      parseJsonl: parseGrokCliLiveJsonl,
      classifyInitial: classifyGrokCliInitial,
      classifyResume: classifyGrokCliResume,
      contractErrors: () => [],
      preparePrivateState,
      privateEnvironment: (privateState) => privateState.environment,
      childEnvironment: (privateState) => privateState.environment,
      resolveLauncher,
      runProcess,
      parseVersion: (stdout) => HOST_VERSION.exec(stdout)?.[1] ?? null,
      sessionId: (parsed) => parsed.session_id,
    },
  });
}
