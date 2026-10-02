import { bench, describe } from 'vitest';
import { z } from 'zod';
import { compose, type MiddlewareContext } from './compose.js';
import { validateMiddleware } from './validate.js';

const piece = {
  inputSchema: {
    channel_id: z.string().regex(/^\d{17,20}$/),
    content: z.string().min(1).max(2000),
    tts: z.boolean().default(false),
  },
};
const args = { channel_id: '112233445566778899', content: 'hello world' };
const dispatch = compose([validateMiddleware()], async (ctx) => ctx.args);

function context(): MiddlewareContext {
  return {
    tool: { name: 'messages_send', category: 'messages', idempotent: false },
    args,
    meta: new Map([['toolPiece', piece]]),
  };
}

// CPU only: validate caller input through the production middleware without REST.
describe('input validation bench', () => {
  bench('validate a repeated tool call', async () => {
    await dispatch(context());
  });
});
