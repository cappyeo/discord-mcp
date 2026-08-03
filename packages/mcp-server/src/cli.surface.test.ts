/**
 * The frozen CLI surface.
 *
 * v1.0.0 commits to the snapshotted top-level command set. Nothing
 * enforced that, which is how the docs came to promise a
 * `start` and a `version` subcommand that never existed - and because `serve`
 * is the default command, `discord-mcp version` silently booted a stdio server
 * instead of failing.
 *
 * Snapshotting the whole tree means a renamed flag, a dropped subcommand, or a
 * changed default fails CI instead of a doc page.
 */
import { describe, expect, it } from 'vitest';
import { buildProgram } from './cli.js';

interface CommandShape {
  name: string;
  isDefault: boolean;
  options: string[];
}

function describeProgram(): { globalOptions: string[]; commands: CommandShape[] } {
  const program = buildProgram();
  return {
    globalOptions: program.options.map((o) => o.flags).sort(),
    commands: program.commands
      .map((c) => ({
        name: c.name(),
        // `_defaultCommandName` is not public API; compare against the parent's
        // resolved default instead.
        isDefault:
          (program as unknown as { _defaultCommandName?: string })._defaultCommandName === c.name(),
        options: c.options.map((o) => o.flags).sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe('CLI surface', () => {
  it('matches the frozen snapshot', () => {
    expect(describeProgram()).toMatchSnapshot();
  });

  it('ships exactly the eight committed subcommands', () => {
    const names = describeProgram().commands.map((c) => c.name);
    expect(names).toEqual([
      'activity',
      'doctor',
      'init',
      'migrate',
      'profile',
      'serve',
      'setup',
      'smoke',
    ]);
  });

  it('keeps serve as the default command', () => {
    const serve = describeProgram().commands.find((c) => c.name === 'serve');
    expect(serve?.isDefault).toBe(true);
  });

  it('builds an independent command tree per call', () => {
    // The isolation property the whole suite depends on: commander retains
    // parsed option values on the instance, so a shared program leaks flags
    // between invocations and makes test outcomes order-dependent.
    expect(buildProgram()).not.toBe(buildProgram());
  });
});
