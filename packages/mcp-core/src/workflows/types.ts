import type { CallToolResult } from '@modelcontextprotocol/server';

export const WORKFLOW_MAX_STEPS = 128;
export const WORKFLOW_ID_RE = /^wf_[0-9a-f]{32}$/;

export type WorkflowStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'needs_review';

export interface WorkflowTarget {
  readonly profile_id: string;
  readonly bot_id?: string;
  readonly guild_id?: string;
  readonly channel_id?: string;
}

export interface WorkflowStepDefinition {
  readonly id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly idempotent: boolean;
  readonly retry_safe: boolean;
}

export type WorkflowStepState = 'pending' | 'in_flight' | 'success' | 'error' | 'skipped';

export interface WorkflowStepCheckpoint {
  readonly definition: WorkflowStepDefinition;
  readonly state: WorkflowStepState;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly result_summary?: unknown;
  readonly error?: { code: string; message: string; retriable: boolean };
}

export interface WorkflowRecord {
  readonly schema_version: 'workflow.v1';
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: WorkflowStatus;
  readonly target: WorkflowTarget;
  readonly target_fingerprint: string;
  readonly start_fingerprint?: string;
  readonly steps: readonly WorkflowStepCheckpoint[];
  readonly current_step: number;
  readonly cancel_requested: boolean;
  readonly failure?: { code: string; message: string };
}

export interface WorkflowInvokeContext {
  readonly invoke: (
    toolName: string,
    args: unknown,
    signal: AbortSignal,
  ) => Promise<CallToolResult>;
  readonly signal?: AbortSignal;
  /** Injected by the server instance; never supplied by the MCP caller. */
  readonly workflowEngine?: import('./engine.js').WorkflowEngine;
  /** Runtime-verified profile/bot binding for this server instance. */
  readonly trustedTarget?: WorkflowTarget;
  /** Re-checks Discord target scope immediately before every step effect. */
  readonly authorizeStep?: (
    toolName: string,
    args: Record<string, unknown>,
    target: WorkflowTarget,
  ) => Promise<void>;
}

export interface WorkflowToolPolicy {
  readonly idempotent: boolean;
  readonly retry_safe: boolean;
}
