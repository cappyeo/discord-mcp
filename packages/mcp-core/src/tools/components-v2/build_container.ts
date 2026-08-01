import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';

export default defineTool({
  name: 'components_v2_build_container',
  category: 'components_v2',
  description:
    '**Purpose**: Build a Components V2 Container (type 17) JSON node ready to nest into `components_v2_send`.\n\n**When to use**: compose a card with accent color + multiple sections/separators.\n\n**Returns**: `{component}` - the JSON node. Pass it inside the `components` array of `components_v2_send`.',
  inputSchema: {
    components: z
      .array(z.unknown())
      .min(1)
      .max(10)
      .describe(
        'Up to 10 child nodes (Section/TextDisplay/MediaGallery/File/Separator/ActionRow). NOT another Container.',
      ),
    accent_color: z
      .number()
      .int()
      .min(0)
      .max(0xffffff)
      .optional()
      .describe('Hex RGB integer (0xFF0000 = red)'),
    spoiler: z.boolean().optional().describe('Wrap container in spoiler tag'),
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
      type: 17,
      components: args.components,
    };
    if (args.accent_color !== undefined) component.accent_color = args.accent_color;
    if (args.spoiler !== undefined) component.spoiler = args.spoiler;
    return dualResult({ text: 'Built Container.', data: { component } });
  },
});
