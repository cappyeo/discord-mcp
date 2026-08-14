import { readActivity, summarizeActivity } from '../lib/activity.js';
import { emitResult } from '../lib/output.js';

export interface ActivityOptions {
  json?: boolean;
  report?: boolean;
}

export function activityAction(options: ActivityOptions): void {
  if (options.report === true) {
    emitResult(
      {
        ok: true,
        exitCode: 0,
        summary: 'voluntary outcome-report link ready; submit it manually if desired',
        details: [
          'No network request was made and no report was submitted.',
          'Open the fixed GitHub template and review every field before submitting it manually.',
        ],
        data: {
          submitted: false,
          network_accessed: false,
          report_url:
            'https://github.com/cappyeo/discord-mcp/issues/new?template=verified-outcome.yml',
        },
      },
      options.json === true,
    );
    return;
  }
  const summary = summarizeActivity(readActivity());
  const details = summary.recent.map((event) =>
    event.version === 2
      ? `${event.at}  blueprint/${event.stage}: ${event.status}/${event.outcome} (${event.transport})`
      : `${event.at}  ${event.command}: ${event.outcome} (${event.signals.join(', ')})`,
  );
  emitResult(
    {
      ok: true,
      exitCode: 0,
      summary:
        summary.total === 0
          ? 'no local activity recorded yet'
          : `${summary.total} local activity record${summary.total === 1 ? '' : 's'} (retains ${summary.retention})`,
      ...(details.length === 0 ? {} : { details }),
      data: {
        total: summary.total,
        retention: summary.retention,
        commands: summary.commands,
        blueprint: summary.blueprint,
        recent: summary.recent,
      },
    },
    options.json === true,
  );
}
