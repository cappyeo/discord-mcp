#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActivationCampaign } from './activation-campaign.mjs';
import {
  assertGrokCliActivationAuthReady,
  GROK_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  GROK_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  runGrokCliActivationTrial,
} from './grok-cli-activation-trial.mjs';

export const GROK_CLI_ACTIVATION_CAMPAIGN_SCHEMA = 'discord-mcp.grok-cli-activation-campaign.v1';
export const GROK_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX =
  'APPROVE_GROK_CLI_ACTIVATION_CAMPAIGN:';

const campaign = createActivationCampaign({
  host: 'grok-cli',
  campaignSchema: GROK_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
  trialFailureSchema: 'discord-mcp.grok-cli-activation-campaign-trial-failure.v1',
  campaignConfirmationPrefix: GROK_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  trialConfirmationPrefix: GROK_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  writeConfirmationPrefix: GROK_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  trialIds: ['grok-cli-activation-01', 'grok-cli-activation-02', 'grok-cli-activation-03'],
  runTrial: runGrokCliActivationTrial,
  preflight: () => assertGrokCliActivationAuthReady(),
});

export const parseGrokCliActivationCampaignArgs = campaign.parseArgs;
export const runGrokCliActivationCampaign = campaign.run;
export const main = campaign.main;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then((code) => {
    process.exitCode = code;
  });
