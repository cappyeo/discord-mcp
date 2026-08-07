/**
 * `discord-mcp doctor` - Plan 9 Phase B.
 *
 * Replaces the Phase A placeholder. Iterates the registered offline
 * checks (Phase C will add online ones) and aggregates their results
 * into a single CommandResult.
 *
 * Exit code mapping (per emitResult contract):
 *   - 0 → all checks ok
 *   - 1 → at least one warn, no fails
 *   - 2 → at least one fail
 *
 * `--online` flag is wired but only filters checks (online-tagged ones
 * are skipped when false). The actual online checks are introduced in
 * Phase C - for now the flag is a no-op gating mechanism, kept here so
 * Phase A's option shape stays stable.
 *
 * Config parse: we attempt `loadConfig(process.env)` once and pass the
 * resolved `Config | null` to each check's `run()`. Checks that need
 * raw env (e.g. token-format) read `process.env` directly so they
 * still report meaningful results when Config rejected the env. The
 * `env-vars` check is the canonical reporter for the parse failure
 * itself (status=fail with zod issue details).
 */
import { type Config, loadConfig } from '@discord-mcp/core';
import { ALL_CHECKS, type CheckResult } from '../lib/checks/index.js';
import { emitResult } from '../lib/output.js';
import { activateProfile, type DiscordMcpProfile } from '../lib/profiles.js';
import {
  CodexLauncherUpdateError,
  inspectCodexClientConfig,
  inspectCodexLauncherUpdate,
} from './update.js';

export interface DoctorOptions {
  json?: boolean;
  online?: boolean;
  profile?: string;
  client?: string;
  config?: string;
  profileDirectory?: string;
}

function codexClientConfigCheck(profile: DiscordMcpProfile, config?: string): CheckResult {
  if (profile.client !== 'codex') {
    return {
      id: 'codex-client-config',
      status: 'warn',
      message: 'Skipped: this saved profile was not generated for Codex.',
      details: { profile: profile.name, audited: false, managed: false },
    };
  }

  try {
    const inspection =
      config === undefined
        ? inspectCodexClientConfig(profile)
        : inspectCodexClientConfig(profile, { config });
    return {
      id: 'codex-client-config',
      status: 'ok',
      message: `Configured Codex launcher is ready for profile ${profile.name}.`,
      details: {
        profile: profile.name,
        audited: true,
        server: inspection.configName,
        version: inspection.currentVersion,
        enabled: inspection.enabled,
        startupTimeoutSec: inspection.startupTimeoutSec,
        dryRun: inspection.dryRun,
        otelEnabled: inspection.otelEnabled,
      },
    };
  } catch (error) {
    if (error instanceof CodexLauncherUpdateError) {
      const message =
        error.kind === 'config-missing' || error.kind === 'config-read'
          ? 'Could not read the saved Codex configuration, so client state is unknown.'
          : 'Skipped: this Codex launcher is custom or ambiguous and remains caller-managed.';
      return {
        id: 'codex-client-config',
        status: 'warn',
        message,
        details: { profile: profile.name, audited: false, managed: false },
      };
    }
    return {
      id: 'codex-client-config',
      status: 'warn',
      message: 'Could not inspect the saved Codex client configuration.',
      details: { profile: profile.name, audited: false, managed: false },
    };
  }
}

async function codexLauncherUpdateCheck(
  profile: DiscordMcpProfile,
  config?: string,
): Promise<CheckResult> {
  try {
    const inspection =
      config === undefined
        ? await inspectCodexLauncherUpdate(profile)
        : await inspectCodexLauncherUpdate(profile, { config });
    if (inspection.updateAvailable) {
      return {
        id: 'codex-launcher-update',
        status: 'warn',
        message: `Update available: ${inspection.currentVersion} -> ${inspection.targetVersion}. Apply only after review.`,
        details: {
          profile: profile.name,
          currentVersion: inspection.currentVersion,
          targetVersion: inspection.targetVersion,
          updateAvailable: true,
        },
      };
    }
    return {
      id: 'codex-launcher-update',
      status: 'ok',
      message: `Generated Codex launcher is current (${inspection.currentVersion}).`,
      details: {
        profile: profile.name,
        currentVersion: inspection.currentVersion,
        targetVersion: inspection.targetVersion,
        updateAvailable: false,
      },
    };
  } catch (error) {
    if (error instanceof CodexLauncherUpdateError) {
      if (error.kind === 'launcher-unrecognized' || error.kind === 'launcher-ambiguous') {
        return {
          id: 'codex-launcher-update',
          status: 'ok',
          message:
            'Skipped: this Codex launcher is custom or ambiguous and remains caller-managed.',
          details: { profile: profile.name, managed: false },
        };
      }
      if (error.kind === 'config-missing' || error.kind === 'config-read') {
        return {
          id: 'codex-launcher-update',
          status: 'warn',
          message: 'Could not read the Codex configuration, so update status is unknown.',
          details: { profile: profile.name, updateAvailable: null },
        };
      }
    }
    return {
      id: 'codex-launcher-update',
      status: 'warn',
      message:
        'Could not check npm for a newer launcher version. Discord connectivity is unaffected.',
      details: { profile: profile.name, updateAvailable: null },
    };
  }
}

export async function doctorAction(opts: DoctorOptions): Promise<void> {
  if (opts.client !== undefined && opts.client !== 'codex') {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `unsupported client audit: ${opts.client}`,
        errors: ['Only --client codex is currently supported.'],
      },
      opts.json === true,
    );
    return;
  }
  if (opts.client === 'codex' && opts.profile === undefined) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: '--client codex requires --profile <name>',
        errors: ['A saved Codex profile identifies exactly which launcher to audit.'],
      },
      opts.json === true,
    );
    return;
  }

  let profile: DiscordMcpProfile | undefined;
  if (opts.profile !== undefined) {
    try {
      profile = activateProfile(opts.profile, {
        ...(opts.profileDirectory === undefined ? {} : { directory: opts.profileDirectory }),
      });
    } catch (error) {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: `could not activate profile ${opts.profile}`,
          errors: [error instanceof Error ? error.message : String(error)],
        },
        opts.json === true,
      );
      return;
    }
  }

  // Filter: when --online is omitted/false, run only offline checks.
  // When --online is true, run everything (offline + online).
  const checks = ALL_CHECKS.filter((c) => opts.online === true || c.online === false);

  let cfg: Config | null = null;
  try {
    cfg = loadConfig(process.env);
  } catch {
    // env-vars check is the canonical reporter - leave cfg as null and
    // let each check decide what to do (most fall back to raw env).
    cfg = null;
  }

  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check.run(cfg));
    } catch (e) {
      // Defensive: a check throwing is a bug, not user error. Surface it
      // as a fail so the run is reproducible from the JSON output.
      results.push({
        id: check.id,
        status: 'fail',
        message: `check threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (opts.client === 'codex' && profile !== undefined) {
    results.push(codexClientConfigCheck(profile, opts.config));
  }

  if (opts.online === true && profile?.client === 'codex') {
    results.push(await codexLauncherUpdateCheck(profile, opts.config));
  }

  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const oks = results.length - fails - warns;
  const exitCode: 0 | 1 | 2 = fails > 0 ? 2 : warns > 0 ? 1 : 0;

  // Pretty-mode detail lines: one bullet per check with status + id +
  // first-line of message. JSON consumers see the full structured array
  // under `data.checks`.
  const detailLines = results.map((r) => {
    const tag = r.status === 'ok' ? 'OK  ' : r.status === 'warn' ? 'WARN' : 'FAIL';
    return `[${tag}] ${r.id}: ${r.message}`;
  });

  emitResult(
    {
      ok: fails === 0,
      exitCode,
      summary: `${results.length} checks: ${fails} fail, ${warns} warn, ${oks} ok`,
      details: detailLines,
      warnings: results.filter((r) => r.status === 'warn').map((r) => `[${r.id}] ${r.message}`),
      errors: results.filter((r) => r.status === 'fail').map((r) => `[${r.id}] ${r.message}`),
      data: { checks: results as unknown as Record<string, unknown>[] },
    },
    opts.json === true,
  );
}
