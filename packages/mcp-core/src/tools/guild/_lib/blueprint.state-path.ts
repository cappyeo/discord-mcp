import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../../../config.js';

export function resolveBlueprintStateDirectory(config: Config): string {
  if (config.MCP_BLUEPRINT_STATE_DIR !== undefined) {
    return resolve(config.MCP_BLUEPRINT_STATE_DIR);
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'discord-mcp', 'blueprints');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'discord-mcp', 'blueprints');
  }
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'discord-mcp', 'blueprints');
}
