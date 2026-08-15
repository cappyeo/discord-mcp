#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActivationCampaign } from './activation-campaign.mjs';
import {
  assertCursorCliActivationAuthReady,
  CURSOR_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  CURSOR_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  runCursorCliActivationTrial,
} from './cursor-cli-activation-trial.mjs';

export const CURSOR_CLI_ACTIVATION_CAMPAIGN_SCHEMA =
  'discord-mcp.cursor-cli-activation-campaign.v1';
export const CURSOR_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX =
  'APPROVE_CURSOR_CLI_ACTIVATION_CAMPAIGN:';

const campaign = createActivationCampaign({
  host: 'cursor-cli',
  campaignSchema: CURSOR_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
  trialFailureSchema: 'discord-mcp.cursor-cli-activation-campaign-trial-failure.v1',
  campaignConfirmationPrefix: CURSOR_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  trialConfirmationPrefix: CURSOR_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  writeConfirmationPrefix: CURSOR_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  trialIds: ['cursor-cli-activation-01', 'cursor-cli-activation-02', 'cursor-cli-activation-03'],
  runTrial: runCursorCliActivationTrial,
  preflight: () => assertCursorCliActivationAuthReady(),
});

export const parseCursorCliActivationCampaignArgs = campaign.parseArgs;
export const runCursorCliActivationCampaign = campaign.run;
export const main = campaign.main;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
