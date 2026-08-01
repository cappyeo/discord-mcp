/**
 * Tiny readline prompt helper - Plan 9 Phase D.
 *
 * `init` is the only sub-command (so far) that needs interactive input.
 * Rather than pull `inquirer`/`prompts`/`enquirer` for a single command
 * we wrap `node:readline/promises` with three thin helpers. Zero new
 * runtime deps, zero ANSI terminal handling - Node's readline already
 * does line editing and ^C handling for us.
 *
 * `isInteractive()` is the canonical TTY gate. Both `stdin` and `stdout`
 * must be TTYs because we read user input on stdin and render the prompt
 * on stdout. CI runners (GitHub Actions, etc.) pipe both, so this returns
 * false there and callers must fall back to defaults / required flags.
 *
 * Every helper accepts a sane default so non-interactive callers can
 * skip the prompt entirely by passing all answers via flags.
 */
import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';

/**
 * True iff both stdin and stdout are TTYs.
 *
 * When false the caller MUST NOT call `ask()` / `askYesNo()` / `askChoice()`
 * - those would block forever on piped stdin or write garbage to a
 * non-TTY stdout. Use the function flags / defaults instead.
 */
export function isInteractive(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/**
 * Prompt for a single line of input. If `defaultValue` is provided and
 * the user submits an empty string, the default is returned; otherwise
 * the trimmed input is returned.
 *
 * The readline interface is created and disposed per call - this keeps
 * the helpers stateless and safe to call from anywhere.
 */
export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const prompt = defaultValue !== undefined ? `${question} [${defaultValue}]: ` : `${question}: `;
    const answer = await rl.question(prompt);
    const trimmed = answer.trim();
    if (trimmed === '' && defaultValue !== undefined) {
      return defaultValue;
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a yes/no answer. The displayed `(Y/n)` or `(y/N)` matches
 * `defaultYes`. Any input starting with 'y' (case-insensitive) → true,
 * otherwise → false. Empty input returns `defaultYes`.
 */
export async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const ans = await ask(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`, defaultYes ? 'y' : 'n');
  return ans.toLowerCase().startsWith('y');
}

/**
 * Prompt for a choice from a fixed list. Renders as a numbered menu and
 * accepts a 1-based index. Out-of-range / non-numeric input clamps to
 * `defaultIndex` (which is 0-based, so it matches array indices).
 *
 * Generic over `T extends string` so callers preserve the literal union
 * (e.g. `'claude-desktop' | 'cursor'`) instead of widening to `string`.
 */
export async function askChoice<T extends string>(
  question: string,
  choices: readonly T[],
  defaultIndex: number,
): Promise<T> {
  const list = choices
    .map((c, i) => `  ${i + 1}. ${c}${i === defaultIndex ? ' (default)' : ''}`)
    .join('\n');
  const ans = await ask(
    `${question}\n${list}\nChoose 1-${choices.length}`,
    String(defaultIndex + 1),
  );
  const parsed = Number.parseInt(ans, 10);
  const idx =
    Math.max(1, Math.min(choices.length, Number.isFinite(parsed) ? parsed : defaultIndex + 1)) - 1;
  // idx is clamped into [0, choices.length-1] so the index is always defined.
  // The non-null assertion is required because tsconfig has noUncheckedIndexedAccess.
  const picked = choices[idx];
  if (picked === undefined) {
    // Defensive: clamp invariant failed (impossible given Math.max/min above).
    throw new Error(`askChoice: clamped index ${idx} out of range [0, ${choices.length - 1}]`);
  }
  return picked;
}
