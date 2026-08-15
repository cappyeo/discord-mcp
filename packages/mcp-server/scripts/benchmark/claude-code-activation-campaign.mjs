#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActivationCampaign } from './activation-campaign.mjs';
import {
  assertClaudeCodeActivationAuthReady,
  CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX,
  CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  runClaudeCodeActivationTrial,
} from './claude-code-activation-trial.mjs';

export const CLAUDE_CODE_ACTIVATION_CAMPAIGN_SCHEMA =
  'discord-mcp.claude-code-activation-campaign.v1';
export const CLAUDE_CODE_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX =
  'APPROVE_CLAUDE_CODE_ACTIVATION_CAMPAIGN:';

const campaign = createActivationCampaign({
  host: 'claude-code',
  campaignSchema: CLAUDE_CODE_ACTIVATION_CAMPAIGN_SCHEMA,
  trialFailureSchema: 'discord-mcp.claude-code-activation-campaign-trial-failure.v1',
  campaignConfirmationPrefix: CLAUDE_CODE_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  trialConfirmationPrefix: CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX,
  writeConfirmationPrefix: CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  trialIds: ['claude-code-activation-01', 'claude-code-activation-02', 'claude-code-activation-03'],
  runTrial: runClaudeCodeActivationTrial,
  preflight: () => assertClaudeCodeActivationAuthReady(),
});

export const parseClaudeCodeActivationCampaignArgs = campaign.parseArgs;
export const runClaudeCodeActivationCampaign = campaign.run;
export const main = campaign.main;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
