import { TemplateBlueprintSchema } from '../../templates/_lib/template.js';
import { recommendTemplates, type TemplateRecommendationData } from '../../templates/recommend.js';
import { blueprintFingerprint, compileGuildBlueprint, type GuildBlueprint } from './blueprint.js';

export interface CompileBlueprintRequestInput {
  readonly request: string;
  readonly preferred_primary_code?: string | undefined;
}

export interface CompileBlueprintRequestResult {
  readonly recommendation: TemplateRecommendationData;
  readonly blueprint: GuildBlueprint | null;
  readonly blueprint_id: string | null;
  readonly blueprint_bytes: number;
  readonly source_permission_risks: readonly string[];
}

/**
 * Shared read-only seam behind the design-only compiler and target-bound
 * planner. Template text and source permission payloads stop at the
 * recommendation boundary; only validated structural evidence enters the
 * trusted blueprint compiler.
 */
export async function compileBlueprintRequest(
  input: CompileBlueprintRequestInput,
  signal: AbortSignal,
): Promise<CompileBlueprintRequestResult> {
  const recommendation = (await recommendTemplates(input, signal)).data;
  if (recommendation.primary === null) {
    return {
      recommendation,
      blueprint: null,
      blueprint_id: null,
      blueprint_bytes: 0,
      source_permission_risks: [],
    };
  }

  const primaryBlueprint = TemplateBlueprintSchema.parse(recommendation.primary.blueprint);
  const blueprint = compileGuildBlueprint({
    request: recommendation.request,
    requested_capabilities: recommendation.intent.capabilities,
    primary: {
      code: recommendation.primary.code,
      blueprint: primaryBlueprint,
      effective_capabilities: recommendation.primary.effective_capabilities,
    },
    inspirations: recommendation.inspirations.map((candidate) => ({
      code: candidate.code,
      blueprint: TemplateBlueprintSchema.parse(candidate.blueprint),
      effective_capabilities: candidate.effective_capabilities,
    })),
  });
  const sourcePermissionRisks = [
    ...new Set([
      ...recommendation.primary.quality.risky_permission_signals,
      ...recommendation.inspirations.flatMap(
        (candidate) => candidate.quality.risky_permission_signals,
      ),
    ]),
  ].sort();
  return {
    recommendation,
    blueprint,
    blueprint_id: blueprintFingerprint(blueprint),
    blueprint_bytes: Buffer.byteLength(JSON.stringify(blueprint), 'utf8'),
    source_permission_risks: sourcePermissionRisks,
  };
}
