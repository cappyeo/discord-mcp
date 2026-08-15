export const BLUEPRINT_TEXT_RECEIPT_PREFIX = 'MCP_BLUEPRINT_RECEIPT ';

type BlueprintTextReceiptPhase = 'plan' | 'apply' | 'evidence';

/**
 * Keep the lifecycle continuation contract visible to MCP hosts that expose
 * only text content to the model. The receipt is deliberately compact and
 * must never contain a plan token, blueprint body, or untrusted Discord text.
 */
export function appendBlueprintTextReceipt(
  text: string,
  phase: BlueprintTextReceiptPhase,
  receipt: Readonly<Record<string, unknown>>,
): string {
  return `${text}\n\n${BLUEPRINT_TEXT_RECEIPT_PREFIX}${JSON.stringify({
    schema_version: 'discord_mcp_blueprint_text_receipt.v1',
    phase,
    ...receipt,
  })}`;
}
