import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createGrokCliActivationLiveAdapter } from './grok-cli-activation-live-adapter.mjs';
import { GROK_CLI_LIFECYCLE_TOOLS } from './grok-cli-live-eval.mjs';

const DRIVER_PATH = fileURLToPath(new URL('./grok-cli-driver.mjs', import.meta.url));

describe('Grok CLI activation adapter', () => {
  it('keeps the host-specific seam thin and host-neutral fields stable', () => {
    const adapter = createGrokCliActivationLiveAdapter({
      verifyRuntimePackage: async () => ({ cliPath: 'C:\\cli.js', corePath: 'C:\\core.js' }),
    });
    expect(adapter).toBeDefined();
    expect(DRIVER_PATH).toContain('grok-cli-driver.mjs');
    expect(GROK_CLI_LIFECYCLE_TOOLS).toEqual({
      initial: 'build_discord_server',
      apply: 'guild_blueprint_apply',
      evidence: 'guild_blueprint_evidence',
    });
  });
});
