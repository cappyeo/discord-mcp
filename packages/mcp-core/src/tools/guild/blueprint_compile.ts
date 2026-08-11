import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { TemplateBlueprintSchema, TemplateCode } from '../templates/_lib/template.js';
import { RecommendationCandidateSchema, recommendTemplates } from '../templates/recommend.js';
import {
  blueprintFingerprint,
  compileGuildBlueprint,
  GuildBlueprintSchema,
} from './_lib/blueprint.js';

const VerificationSchema = z.object({
  catalog_records: z.number().int().nonnegative(),
  metadata_candidates: z.number().int().nonnegative(),
  candidates_inspected: z.number().int().nonnegative(),
  rest_requests: z.number().int().nonnegative(),
  cache_hits: z.number().int().nonnegative(),
  rest_verified: z.number().int().nonnegative(),
  rest_failed: z.number().int().nonnegative(),
  safety_rejected: z.number().int().nonnegative(),
  blueprint_validation: z.enum(['not_run', 'passed']),
  blueprint_bytes: z.number().int().nonnegative(),
});

export default defineTool({
  name: 'guild_blueprint_compile',
  category: 'guild',
  description: [
    '**Purpose**: Turn one natural-language server request into a complete, deterministic, read-only Discord guild blueprint. The tool selects one verified primary public template and up to three bounded inspirations internally, then converts their structural signals and capability modules into safe channels, roles, regenerated permissions, onboarding, AutoMod, and Components V2 content.',
    '',
    '**When to use**: Use this as the high-level entrypoint for requests such as “build a professional gaming server”. A small model needs only this one call; it does not need to call `templates_recommend` first or pass template output between tools.',
    '',
    '**Safety**: Templates are verified structural references, not literal layouts. Source template IDs, permissions, overwrites, names, and descriptions never enter the trusted blueprint. All references are symbolic, generated roles and overwrites reject dangerous permissions, onboarding and AutoMod limits are validated, Components V2 channel placeholders must be resolved and revalidated before send, and this tool never changes Discord.',
    '',
    '**Returns**: Verified source evidence, a stable `blueprint_id`, the symbolic blueprint, bounded verification counters, and explicit prerequisites for a later target-guild dry-run/apply step.',
  ].join('\n'),
  inputSchema: {
    request: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe('Natural-language description of the Discord server to design'),
    preferred_primary_code: TemplateCode.optional().describe(
      'Optional public template code to prefer only when relevant and live-verified safe',
    ),
  },
  outputSchema: {
    status: z.enum(['ready', 'partial', 'no_match']),
    request: z.string(),
    source: z.object({
      catalog_version: z.string(),
      primary: RecommendationCandidateSchema.nullable(),
      inspirations: z.array(RecommendationCandidateSchema).max(3),
      permission_policy: z.literal('discard_source_and_regenerate'),
    }),
    blueprint_id: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    blueprint: GuildBlueprintSchema.nullable(),
    verification: VerificationSchema,
    warnings: z.array(z.string()),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const recommendation = await recommendTemplates(args, ctx.signal);
    const data = recommendation.data;
    if (data.primary === null) {
      return dualResult({
        text: `Guild blueprint is ${data.status}: no verified primary template was available, so no speculative blueprint was emitted and no guild was changed.`,
        data: {
          status: data.status,
          request: data.request,
          source: {
            catalog_version: data.catalog_version,
            primary: null,
            inspirations: [],
            permission_policy: 'discard_source_and_regenerate' as const,
          },
          blueprint_id: null,
          blueprint: null,
          verification: {
            catalog_records: data.verification.catalog_records,
            metadata_candidates: data.verification.metadata_candidates,
            candidates_inspected: data.verification.candidates_inspected,
            rest_requests: data.verification.rest_requests,
            cache_hits: data.verification.cache_hits,
            rest_verified: data.verification.rest_verified,
            rest_failed: data.verification.rest_failed,
            safety_rejected: data.verification.safety_rejected,
            blueprint_validation: 'not_run' as const,
            blueprint_bytes: 0,
          },
          warnings: [
            'A verified primary template is required before compiling a deployable blueprint.',
          ],
        },
      });
    }

    const primaryBlueprint = TemplateBlueprintSchema.parse(data.primary.blueprint);
    const inspirationSources = data.inspirations.map((candidate) => ({
      code: candidate.code,
      blueprint: TemplateBlueprintSchema.parse(candidate.blueprint),
      effective_capabilities: candidate.effective_capabilities,
    }));
    const blueprint = compileGuildBlueprint({
      request: data.request,
      requested_capabilities: data.intent.capabilities,
      primary: {
        code: data.primary.code,
        blueprint: primaryBlueprint,
        effective_capabilities: data.primary.effective_capabilities,
      },
      inspirations: inspirationSources,
    });
    const serialized = JSON.stringify(blueprint);
    const blueprintBytes = Buffer.byteLength(serialized, 'utf8');
    const risks = [
      ...new Set([
        ...data.primary.quality.risky_permission_signals,
        ...data.inspirations.flatMap((candidate) => candidate.quality.risky_permission_signals),
      ]),
    ].sort();
    const warnings = [
      'This is a read-only desired-state blueprint; no Discord guild was changed.',
      'If the target guild is not already a Community guild, enabling Community requires an explicitly authorized Administrator-capable bot.',
    ];
    if (data.primary.quality.confidence === 'medium') {
      warnings.push(
        'The primary template has medium confidence because Discord did not expose a clean dirty-state signal.',
      );
    }
    if (risks.length > 0) {
      warnings.push(
        `Source templates exposed ${risks.length} risky permission class(es); every source permission and overwrite was discarded.`,
      );
    }
    return dualResult({
      text: `Compiled blueprint \`${blueprintFingerprint(blueprint)}\` from one verified primary and ${data.inspirations.length} bounded inspiration(s): ${blueprint.channels.length} channels, ${blueprint.roles.length} roles, ${blueprint.automod.rules.length} AutoMod rules, and ${blueprint.components_v2.publications.length} Components V2 publications. No guild was changed.`,
      data: {
        status: 'ready' as const,
        request: data.request,
        source: {
          catalog_version: data.catalog_version,
          primary: data.primary,
          inspirations: data.inspirations,
          permission_policy: 'discard_source_and_regenerate' as const,
        },
        blueprint_id: blueprintFingerprint(blueprint),
        blueprint,
        verification: {
          catalog_records: data.verification.catalog_records,
          metadata_candidates: data.verification.metadata_candidates,
          candidates_inspected: data.verification.candidates_inspected,
          rest_requests: data.verification.rest_requests,
          cache_hits: data.verification.cache_hits,
          rest_verified: data.verification.rest_verified,
          rest_failed: data.verification.rest_failed,
          safety_rejected: data.verification.safety_rejected,
          blueprint_validation: 'passed' as const,
          blueprint_bytes: blueprintBytes,
        },
        warnings,
      },
    });
  },
});
