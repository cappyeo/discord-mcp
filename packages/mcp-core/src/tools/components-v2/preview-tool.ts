import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { renderPreview } from './_lib/preview.js';

export default defineTool({
  name: 'components_v2_preview',
  category: 'components_v2',
  description:
    '**Purpose**: Render a Components V2 layout as ASCII so the agent can sanity-check structure without sending. Pairs with `components_v2_validate` for offline iteration.\n\n**Returns**: `{ascii}` - multi-line string visualizing the layout.',
  inputSchema: {
    components: z.array(z.unknown()).describe('Components array to render'),
  },
  outputSchema: {
    ascii: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  idempotent: true,
  handler: async (args) => {
    const ascii = renderPreview(args.components as never);
    return dualResult({ text: `\`\`\`\n${ascii}\n\`\`\``, data: { ascii } });
  },
});
