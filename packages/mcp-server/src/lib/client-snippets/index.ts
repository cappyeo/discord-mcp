/**
 * Registry of all supported MCP client snippet generators - Plan 9 Phase D.
 *
 * Order is intentional: Claude Desktop first (most common entry point
 * for new users), Claude Code second (Anthropic CLI), Cursor third
 * (next-most-popular MCP host), Generic last (fallback). The numeric
 * order also drives the default index in interactive `init` choice
 * prompts.
 *
 * To add a new client: implement {@link ClientGenerator} in a new file
 * under this directory, register the singleton here, and add a test.
 * No other surface needs to change - `init` reads from this array.
 */
import { claudeCodeGenerator } from './claude-code.js';
import { claudeDesktopGenerator } from './claude-desktop.js';
import { cursorGenerator } from './cursor.js';
import { genericGenerator } from './generic.js';
import type { ClientGenerator } from './types.js';

export type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

export const ALL_GENERATORS: readonly ClientGenerator[] = [
  claudeDesktopGenerator,
  claudeCodeGenerator,
  cursorGenerator,
  genericGenerator,
];
