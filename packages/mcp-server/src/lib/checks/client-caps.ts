/**
 * `client-caps` check - Plan 9 Phase B.
 *
 * Reports the MCP capabilities discord-mcp ADVERTISES at server boot.
 * This is OFFLINE-only - actual client capability negotiation happens
 * during the MCP `initialize` handshake, which doctor cannot observe
 * without spawning the server. The list below mirrors what
 * `mcp-server/src/server.ts` registers on the SDK Server instance.
 *
 * Always status='ok'. Functions as a self-describing "what does this
 * server support?" for users wiring into a new MCP client.
 */
import type { DoctorCheck } from './index.js';

const ADVERTISED = [
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
] as const;

export const clientCapsCheck: DoctorCheck = {
  id: 'client-caps',
  description: 'MCP capabilities advertised',
  online: false,
  async run() {
    return {
      id: 'client-caps',
      status: 'ok',
      message: `Advertises ${ADVERTISED.length} MCP methods (tools + resources)`,
      details: { advertised: [...ADVERTISED] },
    };
  },
};
