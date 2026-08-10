/**
 * Registry of all known migration adapters - Plan 9 Phase E + Plan 11.
 *
 * `migrate` reads this array exclusively; no other module imports an
 * adapter implementation directly. To add a new source: implement
 * {@link MigrationSource} in a new file under this directory, register
 * the singleton here, and add a test.
 *
 * Plan 9 Phase E shipped the Hubdustry adapter as a reference
 * implementation (its tools are non-Discord - intentionally produces
 * "0 mapped, N unmapped, 0 manual review" against a Hubdustry-shaped tree).
 * Plan 11 Phase B adds the PaSympa adapter - the first Discord-using
 * adapter with a real {@link NAME_MAP} covering ~91 tools across 14
 * modules. Plan 11 Phase C adds quadslab. Plan 11 Phase D adds
 * discord-ops by bookedsolidtech (multi-guild routing, dry-run mode,
 * tool profiles - see file-level "Architectural mismatches" in
 * `discord-ops.ts`). Future phases add barryyip.
 */
import { discordOpsAdapter } from './discord-ops.js';
import { hubdustryGoMcpAdapter } from './hubdustry-go-mcp.js';
import { pasympaAdapter } from './pasympa.js';
import { quadslabAdapter } from './quadslab.js';
import type { MigrationSource } from './types.js';

export const ALL_ADAPTERS: readonly MigrationSource[] = [
  hubdustryGoMcpAdapter,
  pasympaAdapter,
  quadslabAdapter,
  discordOpsAdapter,
  // Plan 11 also adds: barryyipAdapter
];

export type {
  ManualReviewItem,
  MappedTool,
  MigrationResult,
  MigrationSource,
} from './types.js';
