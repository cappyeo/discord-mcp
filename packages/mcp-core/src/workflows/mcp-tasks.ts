import {
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  INVALID_PARAMS,
  MissingRequiredClientCapabilityError,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  type Server,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkflowStore } from './store.js';
import {
  WORKFLOW_ID_RE,
  type WorkflowRecord,
  type WorkflowStatus,
  type WorkflowTarget,
} from './types.js';

export const WORKFLOW_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

export function supportsWorkflowTasks(envelope: object | undefined): boolean {
  const meta = envelope as
    | { [PROTOCOL_VERSION_META_KEY]?: string; [CLIENT_CAPABILITIES_META_KEY]?: ClientCapabilities }
    | undefined;
  const extensions = meta?.[CLIENT_CAPABILITIES_META_KEY]?.extensions;
  return (
    meta?.[PROTOCOL_VERSION_META_KEY] === '2026-07-28' &&
    extensions !== undefined &&
    Object.hasOwn(extensions, WORKFLOW_TASKS_EXTENSION)
  );
}

function taskMetadata(record: WorkflowRecord, workflowStatus: WorkflowStatus) {
  const status =
    workflowStatus === 'cancelled'
      ? 'cancelled'
      : ['completed', 'failed', 'needs_review'].includes(workflowStatus)
        ? 'completed'
        : 'working';
  return {
    taskId: record.id,
    status,
    createdAt: record.created_at,
    lastUpdatedAt: record.updated_at,
    ttlMs: null,
    ...(status === 'working' ? { pollIntervalMs: 1000 } : {}),
  };
}

export async function taskFromWorkflowStart(
  result: CallToolResult,
  store: WorkflowStore,
): Promise<CallToolResult> {
  const id = (result.structuredContent as { id?: unknown } | undefined)?.id;
  if (result.isError === true || typeof id !== 'string' || !WORKFLOW_ID_RE.test(id)) return result;
  const record = await store.get(id);
  if (record?.start_fingerprint === undefined) return result;
  return { resultType: 'task', ...taskMetadata(record, record.status), content: [] };
}

const taskParams = z.object({ taskId: z.string().regex(WORKFLOW_ID_RE) });

type TaskWorkflowCall = (
  tool: 'workflow_status' | 'workflow_cancel',
  args: { id: string; target: WorkflowTarget },
  signal: AbortSignal,
) => Promise<CallToolResult>;

function taskNotFound(): ProtocolError {
  return new ProtocolError(INVALID_PARAMS, 'Workflow task not found for this caller.');
}

export function registerWorkflowTasks(
  server: Server,
  store: WorkflowStore,
  callWorkflow: TaskWorkflowCall,
): void {
  async function readTask(taskId: string, envelope: object | undefined, signal: AbortSignal) {
    if (!supportsWorkflowTasks(envelope)) {
      throw new MissingRequiredClientCapabilityError({
        requiredCapabilities: { extensions: { [WORKFLOW_TASKS_EXTENSION]: {} } },
      });
    }
    const record = await store.get(taskId);
    if (record?.start_fingerprint === undefined) throw taskNotFound();
    const args = { id: taskId, target: record.target };
    // Re-enter the ordinary workflow tool to recheck bot, guild and channel scope.
    const result = await callWorkflow('workflow_status', args, signal);
    if (result.isError === true) throw taskNotFound();
    const { status } = result.structuredContent as { status: WorkflowStatus };
    return { record, args, result, status };
  }

  server.setRequestHandler('tasks/get', { params: taskParams }, async ({ taskId }, { mcpReq }) => {
    const { record, status, result } = await readTask(taskId, mcpReq.envelope, mcpReq.signal);
    const task = taskMetadata(record, status);
    if (task.status !== 'completed') return { resultType: 'complete', ...task };
    const failed = status === 'failed' || status === 'needs_review';
    return {
      resultType: 'complete',
      ...task,
      result: failed ? { ...result, isError: true } : result,
    };
  });
  server.setRequestHandler(
    'tasks/cancel',
    { params: taskParams },
    async ({ taskId }, { mcpReq }) => {
      const { record, status, args } = await readTask(taskId, mcpReq.envelope, mcpReq.signal);
      if (taskMetadata(record, status).status === 'working') {
        const result = await callWorkflow('workflow_cancel', args, mcpReq.signal);
        if (result.isError === true) {
          throw new ProtocolError(INVALID_PARAMS, 'Workflow cancellation was rejected by policy.');
        }
      }
      return { resultType: 'complete' };
    },
  );
  server.setRequestHandler(
    'tasks/update',
    { params: taskParams },
    async ({ taskId }, { mcpReq }) => {
      await readTask(taskId, mcpReq.envelope, mcpReq.signal);
      // The SDK lifts inputResponses out of params. This pilot has no pending inputs.
      if (mcpReq.inputResponses === undefined) {
        throw new ProtocolError(INVALID_PARAMS, 'Task update requires inputResponses.');
      }
      return { resultType: 'complete' };
    },
  );
}
