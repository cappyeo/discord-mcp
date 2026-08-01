import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { Button } from './_lib/schema.js';

export default defineTool({
  name: 'components_v2_build_section',
  category: 'components_v2',
  description:
    '**Purpose**: Build a Components V2 Section (type 9) - 1-3 TextDisplay lines plus a REQUIRED Thumbnail or Button accessory (Discord rejects a Section without one).\n\n**When to use**: card-like content with header + supporting text + image.\n\n**Returns**: `{component}` - Section JSON node.',
  inputSchema: {
    text: z.array(z.string().min(1).max(4000)).min(1).max(3).describe('1-3 markdown text lines'),
    accessory: z
      .union([
        z.object({
          type: z.literal(11),
          media: z.object({ url: z.string().url() }),
          description: z.string().max(1024).optional(),
          spoiler: z.boolean().optional(),
        }),
        Button,
      ])
      .describe('Required Thumbnail (type 11) or Button (type 2)'),
  },
  outputSchema: {
    component: z.unknown(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  idempotent: true,
  handler: async (args) => {
    const component: Record<string, unknown> = {
      type: 9,
      components: args.text.map((t) => ({ type: 10, content: t })),
      accessory: args.accessory,
    };
    return dualResult({ text: 'Built Section.', data: { component } });
  },
});
