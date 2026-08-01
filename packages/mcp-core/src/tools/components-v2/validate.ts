import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { validateComponentsV2 } from './_lib/validator.js';

export default defineTool({
  name: 'components_v2_validate',
  category: 'components_v2',
  description:
    '**Purpose**: Validate a Components V2 components array OFFLINE (no Discord API call). Enforces the 40-cap, placement and nesting rules, ActionRow cardinality, Button style contracts, unique custom_id values, accessory requirements, and MediaGallery range. File components are rejected because the current send/edit tools do not upload attachments.\n\n**When to use**: iterate on a layout before sending. Saves round-trips for agents constructing complex cards.\n\n**Returns**: `{valid, issues:[{path, code, message, fix_hint?}]}`.',
  inputSchema: {
    components: z.array(z.unknown()).describe('Components array (will be validated)'),
  },
  outputSchema: {
    valid: z.boolean(),
    issues: z.array(
      z.object({
        path: z.string(),
        code: z.string(),
        message: z.string(),
        fix_hint: z.string().optional(),
      }),
    ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  idempotent: true,
  handler: async (args) => {
    const result = validateComponentsV2(args.components);
    const lines = result.valid
      ? '_Layout is valid._'
      : result.issues
          .map(
            (i) =>
              `- \`${i.path}\` **${i.code}**: ${i.message}${i.fix_hint !== undefined ? ` _(${i.fix_hint})_` : ''}`,
          )
          .join('\n');
    return dualResult({
      text: `**Components V2 validation**: ${result.valid ? '✅ valid' : `❌ ${result.issues.length} issue(s)`}\n${lines}`,
      data: { valid: result.valid, issues: result.issues.map((i) => ({ ...i })) },
    });
  },
});
