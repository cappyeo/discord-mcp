'use strict';

const heartbeatStartedAt = Date.now();
const heartbeatTimer = setInterval(() => {
  const resourceCounts = Object.create(null);
  for (const type of process.getActiveResourcesInfo()) {
    resourceCounts[type] = (resourceCounts[type] ?? 0) + 1;
  }
  process.stderr.write(
    `[coverage-heartbeat] ${JSON.stringify({
      pid: process.pid,
      elapsed_ms: Date.now() - heartbeatStartedAt,
      rss_bytes: process.memoryUsage().rss,
      resource_types: resourceCounts,
    })}\n`,
  );
}, 60_000);
heartbeatTimer.unref();
