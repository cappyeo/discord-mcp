/**
 * `otel-reachable` check - Plan 9 Phase C.
 *
 * Probes the configured OTLP endpoint with an HTTP HEAD request to
 * `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`. We treat 200/204/405 as
 * "server alive" (405 happens when the endpoint requires POST but the
 * port/host responds), 4xx as a warning (auth/header config issue) and
 * 5xx / network errors as failures depending on which.
 *
 * Privacy: `OTEL_EXPORTER_OTLP_HEADERS` value is NEVER included in the
 * result (it can contain bearer tokens, API keys, etc.). We surface
 * only a count when relevant. The endpoint itself is reported with any
 * inline basic-auth credentials stripped - collector URLs commonly
 * carry them (`https://user:APIKEY@otlp.example.com`) and `doctor
 * --json` is exactly what people paste into issues and CI logs.
 *
 * Skip semantics:
 *   - cfg === null → 'warn' (canonical reporter is env-vars)
 *   - !OTEL_ENABLED → 'ok', skip request entirely
 *   - OTEL_ENABLED but no endpoint → 'warn'
 *
 * Timeout: 3 seconds via AbortController. Shorter than token-online's
 * 5s because OTLP collectors are typically local / on-network.
 */
import type { DoctorCheck } from './index.js';

const REQUEST_TIMEOUT_MS = 3000;

/**
 * Count the number of comma-separated key=value pairs in
 * OTEL_EXPORTER_OTLP_HEADERS without exposing any value. Used only for
 * surfacing `headers_configured: <n>` in details - never the raw string.
 */
function countHeaders(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * Blank out `user:password@` from an endpoint before it is reported.
 * Host/port stay visible - that is the diagnostically useful part.
 * The credential-free case returns the raw string so the reported value
 * stays byte-identical to what the operator configured (`new URL()`
 * normalization would otherwise add a trailing slash).
 */
function redactEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username === '' && url.password === '') {
    return raw;
  }
  url.username = '';
  url.password = '';
  return url.toString();
}

export const otelReachableCheck: DoctorCheck = {
  id: 'otel-reachable',
  description: 'OTLP endpoint reachability',
  online: true,
  async run(config) {
    if (config === null) {
      return {
        id: 'otel-reachable',
        status: 'warn',
        message: 'cannot verify - config invalid',
      };
    }

    if (!config.OTEL_ENABLED) {
      return {
        id: 'otel-reachable',
        status: 'ok',
        message: 'OTel disabled (OTEL_ENABLED=false)',
      };
    }

    const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (endpoint === undefined) {
      return {
        id: 'otel-reachable',
        status: 'warn',
        message: 'OTEL_ENABLED=true but no OTLP endpoint set',
      };
    }

    // Trim trailing slash so `${endpoint}/v1/traces` doesn't double-up.
    const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
    const url = `${base}/v1/traces`;
    // Reported form only - the request itself uses `url`, credentials included.
    const safeEndpoint = redactEndpoint(endpoint);
    const headersConfigured = countHeaders(config.OTEL_EXPORTER_OTLP_HEADERS);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: ctrl.signal,
      });

      // 200/204 → server explicitly accepted HEAD.
      // 405 → "method not allowed" - server is alive but only accepts POST,
      // which is what the OTLP HTTP exporter actually uses. Treat as ok.
      if (res.status === 200 || res.status === 204 || res.status === 405) {
        return {
          id: 'otel-reachable',
          status: 'ok',
          message: `OTLP endpoint reachable (HEAD → ${res.status})`,
          details: {
            endpoint: safeEndpoint,
            method: 'HEAD',
            status: res.status,
            headers_configured: headersConfigured,
          },
        };
      }

      // Other 4xx - endpoint exists but rejected our request. Likely an
      // auth/header issue; surface as warn so users can investigate but
      // don't block.
      if (res.status >= 400 && res.status < 500) {
        return {
          id: 'otel-reachable',
          status: 'warn',
          message: 'endpoint reachable but rejected - check headers/auth/path',
          details: {
            endpoint: safeEndpoint,
            method: 'HEAD',
            status: res.status,
            headers_configured: headersConfigured,
          },
        };
      }

      // 5xx - server is up but unhealthy. Warn (recoverable).
      if (res.status >= 500 && res.status < 600) {
        return {
          id: 'otel-reachable',
          status: 'warn',
          message: `endpoint server error: ${res.status}`,
          details: {
            endpoint: safeEndpoint,
            method: 'HEAD',
            status: res.status,
            headers_configured: headersConfigured,
          },
        };
      }

      // 1xx/3xx - unusual. Surface as warn with status.
      return {
        id: 'otel-reachable',
        status: 'warn',
        message: `unexpected response: ${res.status}`,
        details: {
          endpoint: safeEndpoint,
          method: 'HEAD',
          status: res.status,
          headers_configured: headersConfigured,
        },
      };
    } catch (e) {
      // ECONNREFUSED, ENOTFOUND, AbortError (timeout) - collector unreachable.
      // This is a fail (not warn) because if you've enabled OTEL_ENABLED and
      // set an endpoint, you almost certainly want spans to actually export.
      const message = e instanceof Error ? e.message : String(e);
      return {
        id: 'otel-reachable',
        status: 'fail',
        message: `OTel endpoint unreachable: ${message}`,
        details: {
          endpoint: safeEndpoint,
          method: 'HEAD',
          headers_configured: headersConfigured,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
