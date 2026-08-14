export interface CatalogOptions {
  check?: boolean;
  json?: boolean;
}

async function emitInvalidOptions(asJson: boolean): Promise<void> {
  const { emitResult } = await import('../lib/output.js');
  emitResult(
    {
      ok: false,
      summary: 'Catalog JSON output requires --check',
      errors: ['Run discord-mcp catalog --check --json.'],
      exitCode: 2,
    },
    asJson,
  );
}

async function checkCatalog(asJson: boolean): Promise<void> {
  const [{ runCatalogCheck }, { emitResult }] = await Promise.all([
    import('./catalog-check.js'),
    import('../lib/output.js'),
  ]);
  try {
    const data = await runCatalogCheck();
    emitResult(
      {
        ok: true,
        summary: 'Credential-free MCP catalog check passed',
        details: [
          `tools/list: ${data.tool_count} tools`,
          `resources/list: ${data.resource_count} resources`,
          `tools/call: blocked with ${data.execution_guard}`,
          'Activity Evidence: not created',
        ],
        data: { ...data },
        exitCode: 0,
      },
      asJson,
    );
  } catch (error) {
    emitResult(
      {
        ok: false,
        summary: 'Credential-free MCP catalog check failed',
        errors: [error instanceof Error ? error.message : String(error)],
        exitCode: 2,
      },
      asJson,
    );
  }
}

/** Start the schema-only MCP server or run its bounded self-check. */
export async function catalogAction(opts: CatalogOptions = {}): Promise<void> {
  if (opts.json === true && opts.check !== true) {
    await emitInvalidOptions(true);
    return;
  }
  if (opts.check === true) {
    await checkCatalog(opts.json === true);
    return;
  }
  try {
    const { startCatalog } = await import('../transports/catalog.js');
    await startCatalog();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`discord-mcp catalog failed to start: ${message}\n`);
    process.exitCode = 1;
  }
}
