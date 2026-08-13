/** Start the schema-only MCP server. */
export async function catalogAction(): Promise<void> {
  try {
    const { startCatalog } = await import('../transports/catalog.js');
    await startCatalog();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`discord-mcp catalog failed to start: ${message}\n`);
    process.exitCode = 1;
  }
}
