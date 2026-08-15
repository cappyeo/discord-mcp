#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActivationCampaign } from './activation-campaign.mjs';
import {
  ANTIGRAVITY_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  ANTIGRAVITY_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  assertAntigravityCliActivationAuthReady,
  runAntigravityCliActivationTrial,
} from './antigravity-cli-activation-trial.mjs';

export const ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_SCHEMA =
  'discord-mcp.antigravity-cli-activation-campaign.v1';
export const ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX =
  'APPROVE_ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN:';

const campaign = createActivationCampaign({
  host: 'antigravity-cli',
  campaignSchema: ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
  trialFailureSchema: 'discord-mcp.antigravity-cli-activation-campaign-trial-failure.v1',
  campaignConfirmationPrefix: ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  trialConfirmationPrefix: ANTIGRAVITY_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  writeConfirmationPrefix: ANTIGRAVITY_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  trialIds: [
    'antigravity-cli-activation-01',
    'antigravity-cli-activation-02',
    'antigravity-cli-activation-03',
  ],
  runTrial: runAntigravityCliActivationTrial,
  preflight: () => assertAntigravityCliActivationAuthReady(),
});

export const parseAntigravityCliActivationCampaignArgs = campaign.parseArgs;
export const runAntigravityCliActivationCampaign = campaign.run;
export const main = campaign.main;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
