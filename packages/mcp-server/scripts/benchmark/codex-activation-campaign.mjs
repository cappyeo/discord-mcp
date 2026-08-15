#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActivationCampaign } from './activation-campaign.mjs';
import {
  CODEX_ACTIVATION_CONFIRMATION_PREFIX,
  CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  runCodexActivationTrial,
} from './codex-activation-trial.mjs';

export const CODEX_ACTIVATION_CAMPAIGN_SCHEMA = 'discord-mcp.codex-activation-campaign.v1';
export const CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX = 'APPROVE_CODEX_ACTIVATION_CAMPAIGN:';

const campaign = createActivationCampaign({
  host: 'codex',
  campaignSchema: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
  trialFailureSchema: 'discord-mcp.codex-activation-campaign-trial-failure.v1',
  campaignConfirmationPrefix: CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  trialConfirmationPrefix: CODEX_ACTIVATION_CONFIRMATION_PREFIX,
  writeConfirmationPrefix: CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  trialIds: ['codex-activation-01', 'codex-activation-02', 'codex-activation-03'],
  runTrial: runCodexActivationTrial,
});

export const parseCodexActivationCampaignArgs = campaign.parseArgs;
export const runCodexActivationCampaign = campaign.run;
export const main = campaign.main;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
