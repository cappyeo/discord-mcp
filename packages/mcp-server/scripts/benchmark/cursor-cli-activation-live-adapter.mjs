import { createActivationLiveAdapter } from './activation-live-adapter.mjs';
import {
  prepareCursorCliPrivateState,
  resolveCursorCliLauncher,
  runBoundedCursorCliProcess,
} from './cursor-cli-driver.mjs';
import {
  buildCursorCliLiveArguments,
  CURSOR_CLI_HOST,
  CURSOR_CLI_LIFECYCLE_TOOLS,
  CURSOR_CLI_QUALIFIED_TOOLS,
  classifyCursorCliInitial,
  classifyCursorCliResume,
  parseCursorCliLiveJsonl,
} from './cursor-cli-live-eval.mjs';

const HOST_VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u;
const DEFAULT_REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';

/** Create the audited Cursor Agent adapter over the host-neutral activation lifecycle. */
export function createCursorCliActivationLiveAdapter(options = {}) {
  const {
    resolveLauncher = resolveCursorCliLauncher,
    runProcess = runBoundedCursorCliProcess,
    preparePrivateState = prepareCursorCliPrivateState,
    nodePath = process.execPath,
    initialRequest = DEFAULT_REQUEST,
    ...common
  } = options;
  return createActivationLiveAdapter({
    ...common,
    hostDriver: {
      id: CURSOR_CLI_HOST,
      label: 'Cursor Agent CLI',
      processDidNotCloseCode: 'CURSOR_CLI_PROCESS_DID_NOT_CLOSE',
      initialTool: CURSOR_CLI_LIFECYCLE_TOOLS.initial,
      applyTool: CURSOR_CLI_LIFECYCLE_TOOLS.apply,
      evidenceTool: CURSOR_CLI_LIFECYCLE_TOOLS.evidence,
      initialQualifiedTool: CURSOR_CLI_QUALIFIED_TOOLS.initial,
      applyQualifiedTool: CURSOR_CLI_QUALIFIED_TOOLS.apply,
      evidenceQualifiedTool: CURSOR_CLI_QUALIFIED_TOOLS.evidence,
      sessionField: 'cursorSessionId',
      sessionSchema: 'discord-mcp.cursor-cli-activation-session.v1',
      initialRequest,
      mode: 'allow',
      nodePath,
      buildEnvironment: () => ({}),
      buildArguments: buildCursorCliLiveArguments,
      parseJsonl: parseCursorCliLiveJsonl,
      classifyInitial: classifyCursorCliInitial,
      classifyResume: classifyCursorCliResume,
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
