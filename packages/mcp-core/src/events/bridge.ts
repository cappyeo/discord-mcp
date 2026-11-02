import { request } from 'node:http';
import { ProtocolError } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { EventBridge } from './contract.js';

export function createEventBridge(
  socketPath: string,
  owner: string,
  catalog: 'all' | 'dm' | 'mentions' = 'all',
): EventBridge {
  const allowed =
    catalog === 'all'
      ? ['message.created', 'message.mentioned']
      : [catalog === 'dm' ? 'message.created' : 'message.mentioned'];
  return {
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const eventId = (params as { event_id?: unknown })?.event_id;
        if (
          (catalog === 'mentions' && method.startsWith('dm/')) ||
          (typeof eventId === 'string' &&
            ((catalog === 'mentions' && eventId.startsWith('discord_dm_')) ||
              (catalog === 'dm' && eventId.startsWith('discord_mention_'))))
        ) {
          reject(new ProtocolError(-32001, 'Event is unavailable on this MCP connection'));
          return;
        }
        if (
          (method === 'events/subscribe' || method === 'events/unsubscribe') &&
          !allowed.includes(String((params as { name?: unknown })?.name))
        ) {
          reject(new ProtocolError(-32001, 'Event is unavailable on this MCP connection'));
          return;
        }
        const body = JSON.stringify({ owner, method, params });
        const req = request(
          {
            socketPath,
            path: '/',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(30_000),
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => {
              text += chunk;
              if (Buffer.byteLength(text) > 262_144) res.destroy();
            });
            res.on('error', () =>
              reject(new ProtocolError(-32603, 'Events worker response failed')),
            );
            res.on('end', () => {
              try {
                const value = JSON.parse(text);
                if (value.error)
                  reject(
                    new ProtocolError(value.error.code, value.error.message, value.error.data),
                  );
                else if (method === 'events/list')
                  resolve({
                    ...value.result,
                    events: (value.result.events as Array<{ name: string }>).filter((event) =>
                      allowed.includes(event.name),
                    ),
                  });
                else resolve(value.result);
              } catch {
                reject(new ProtocolError(-32603, 'Events worker response failed'));
              }
            });
          },
        );
        req.on('error', () => reject(new ProtocolError(-32603, 'Events worker unavailable')));
        req.end(body);
      }),
  };
}
export function eventBridgeFromConfig(config: Config): EventBridge | undefined {
  const socket = config.MCP_EVENTS_SOCKET;
  const owner = config.MCP_EVENTS_OWNER;
  if (!socket && !owner) return undefined;
  if (!socket?.startsWith('/') || !owner)
    throw new Error('MCP_EVENTS_SOCKET and MCP_EVENTS_OWNER are required together');
  return createEventBridge(socket, owner, config.MCP_EVENTS_CATALOG);
}
