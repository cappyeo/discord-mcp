import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';

export default defineTool({
  name: 'components_v2_build_media_gallery',
  category: 'components_v2',
  description:
    '**Purpose**: Build a Components V2 MediaGallery (type 12) - 1-10 media items.\n\n**Returns**: `{component}` - MediaGallery JSON node.',
  inputSchema: {
    items: z
      .array(
        z.object({
          url: z.string().url(),
          description: z.string().max(1024).optional(),
          spoiler: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(10)
      .describe('1-10 media items'),
  },
  outputSchema: { component: z.unknown() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  idempotent: true,
  handler: async (args) => {
    const component = {
      type: 12,
      items: args.items.map((it) => {
        const item: Record<string, unknown> = { media: { url: it.url } };
        if (it.description !== undefined) item.description = it.description;
        if (it.spoiler !== undefined) item.spoiler = it.spoiler;
        return item;
      }),
    };
    return dualResult({ text: 'Built MediaGallery.', data: { component } });
  },
});
