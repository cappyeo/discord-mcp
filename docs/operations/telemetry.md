# Telemetry (OpenTelemetry) — Operator Guide

`discord-mcp` ships with OpenTelemetry traces and metrics built on top of
the official OTel JS SDK. This document covers how to enable telemetry,
where to send the data, and what signals you get out of the box.

The SDK is **disabled by default**: if you do not set `OTEL_ENABLED=true`
the server runs with no exporter wired and zero overhead. All telemetry
configuration is environment-variable driven (no code changes needed).

---

## Quickstart

### Honeycomb

```bash
export OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_API_KEY,x-honeycomb-dataset=discord-mcp
export OTEL_SERVICE_NAME=discord-mcp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

npx discord-mcp
```

You should see traces appear in the Honeycomb UI under the
`discord-mcp` dataset within ~10 seconds (the OTLP exporter batches).

### Local dev with Jaeger + OTel Collector

Save as `docker-compose.telemetry.yml`:

```yaml
services:
  jaeger:
    image: jaegertracing/all-in-one:1.62
    ports:
      - "16686:16686"   # UI
      - "4317:4317"     # OTLP gRPC (forwarded by collector below if needed)

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.110.0
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    volumes:
      - ./otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml
    ports:
      - "4318:4318"     # OTLP HTTP (what discord-mcp speaks)
      - "8888:8888"     # Internal collector metrics
    depends_on:
      - jaeger
```

`otel-collector-config.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]
```

Then:

```bash
docker compose -f docker-compose.telemetry.yml up -d
export OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
npx discord-mcp
# Jaeger UI: http://localhost:16686
```

### Console exporter (debugging only)

```bash
export OTEL_ENABLED=true
export OTEL_CONSOLE_EXPORTER=true
npx discord-mcp 2>otel.jsonl
```

The console exporter writes spans as JSON to **stderr** (stdout is
reserved for JSON-RPC frames). Pipe stderr to a file or `tail` it.
Useful when you don't have a collector handy and just want to confirm
that spans fire.

---

## Available signals

### Tool-level metrics

| Metric | Type | Description |
| ------ | ---- | ----------- |
| `mcp.tool.duration_ms` | Histogram | Wall-clock duration of each tool call (milliseconds). |
| `mcp.tool.calls` | Counter | Total tool calls, labelled by `status` ∈ `{ok, tool_error, error}`. |
| `mcp.tool.errors` | Counter | Subset of calls that ended in error (`tool_error` or thrown). |

Common labels on every metric: `mcp.tool.name`, `mcp.tool.category`,
`mcp.tool.idempotent`, `mcp.transport`, `status`. **`mcp.request_id`
is intentionally NOT a label** — it would explode cardinality and make
the histograms useless.

### Resilience metrics

| Metric | Type | Description |
| ------ | ---- | ----------- |
| `mcp.circuit.transitions` | Counter | Circuit breaker state transitions. One label: `to_state` ∈ `{open, half-open, closed}`. There is no `from` label — the destination state alone identifies the transition. |
| `mcp.bulkhead.rejected.count` | Counter | Calls fast-rejected because the bulkhead semaphore was full. **No labels.** |
| `mcp.deadletter.count` | Counter | Calls that exhausted retries / were circuit-rejected and surfaced to the client as a structured error. One label: `error.type`. |

The three resilience metrics carry **no per-tool or per-route dimension**,
by construction. They are emitted from the cockatiel policy built once per
process by `buildPolicy`, and cockatiel's `onBreak` / `onReset` /
rejection hooks receive no per-call context to attribute them with. Slice
tool-level behavior with the tool metrics above, or with spans; treat
these three as process-wide health counters.

### Spans

Every tool invocation produces an `mcp.tool.<tool_name>` SERVER span
with:

- Standard attributes: `mcp.tool.name`, `mcp.tool.category`,
  `mcp.tool.idempotent`, `mcp.transport`, `mcp.request_id` (if known).
- Span event `mcp.tool.args` with attribute `mcp.args.redacted`
  containing the JSON-stringified, redacted arg payload (see
  `audit.md` for the redaction policy).
- Status: `OK` on success, `ERROR` with `tool returned isError` for
  structured tool errors, or the thrown exception message for crashes.

If `OTEL_ENABLED=true` AND the underlying Discord REST call fires under
the active span context, you also get a child CLIENT span from
`@opentelemetry/instrumentation-undici` with the standard
`http.request.method`, `url.full`, `http.response.status_code`
attributes plus the `discord.route` (route-redacted, e.g.
`POST /channels/:id/messages`).

---

## Dashboards (text-only sketches)

For Grafana + Prometheus, useful starter queries:

- **Tool error rate, last 5m**:
  `sum by (mcp.tool.name) (rate(mcp_tool_errors_total[5m])) / sum by (mcp.tool.name) (rate(mcp_tool_calls_total[5m]))`
- **p95 tool latency**:
  `histogram_quantile(0.95, sum by (mcp.tool.name, le) (rate(mcp_tool_duration_ms_bucket[5m])))`
- **Circuit open events**:
  `sum(rate(mcp_circuit_transitions_total{to_state="open"}[1h]))`
- **Bulkhead saturation**:
  `sum(rate(mcp_bulkhead_rejected_count_total[5m]))`
- **Dead letters by cause**:
  `sum by (error_type) (rate(mcp_deadletter_count_total[5m]))`

The label is `to_state`, not `to` — a query written as `{to="open"}`
matches nothing and silently reports a permanently healthy circuit.
Neither the bulkhead nor the circuit metric has a `route` label to group
by.

For Honeycomb, useful starting BubbleUp / triggers:

- Slow `mcp.tool.<name>` spans (P95 > 1s).
- `mcp.tool.errors` > 10 per minute.
- `mcp.deadletter.count` > 0 (every dead-letter is a real failure
  the client saw).

The shipped repository does NOT include exported board JSON — every
deployment has different SLOs. Use the queries above as a starting
point and tune to your environment.

---

## Sampling

The default trace sampler is `parentbased_always_on`: if an incoming
trace context is set (parent), defer to it; otherwise sample 100%. This
is fine for low-volume bot deployments. For high-volume servers, switch
to:

```bash
export OTEL_TRACES_SAMPLER=parentbased_traceidratio
export OTEL_TRACES_SAMPLER_ARG=0.05    # 5% sampling
```

Metrics are NOT affected by trace sampling — counters and histograms
are always reported.

---

## Reference: env vars

| Var | Default | Description |
| --- | ------- | ----------- |
| `OTEL_ENABLED` | `false` | Master switch. When false, SDK is not booted. |
| `OTEL_SERVICE_NAME` | `discord-mcp` | `service.name` resource attribute. |
| `OTEL_SERVICE_VERSION` | (package version) | `service.version` resource attribute. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | OTLP collector endpoint (e.g. `http://localhost:4318`). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | One of `http/protobuf`, `http/json`, `grpc`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | (unset) | Comma-separated `key=value` pairs (e.g. for vendor auth). |
| `OTEL_TRACES_SAMPLER` | `parentbased_always_on` | One of the standard OTel samplers. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | Ratio for ratio-based samplers. |
| `OTEL_CONSOLE_EXPORTER` | `false` | When true, also writes spans to stderr as JSON (debug aid). |
