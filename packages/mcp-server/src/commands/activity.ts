import { readActivity, summarizeActivity } from '../lib/activity.js';
import { emitResult } from '../lib/output.js';

export interface ActivityOptions {
  json?: boolean;
}

export function activityAction(options: ActivityOptions): void {
  const summary = summarizeActivity(readActivity());
  const details = summary.recent.map(
    (event) => `${event.at}  ${event.command}: ${event.outcome} (${event.signals.join(', ')})`,
  );
  emitResult(
    {
      ok: true,
      exitCode: 0,
      summary:
        summary.total === 0
          ? 'no local onboarding activity recorded yet'
          : `${summary.total} local onboarding activity record${summary.total === 1 ? '' : 's'} (retains ${summary.retention})`,
      ...(details.length === 0 ? {} : { details }),
      data: {
        total: summary.total,
        retention: summary.retention,
        commands: summary.commands,
        recent: summary.recent,
      },
    },
    options.json === true,
  );
}
