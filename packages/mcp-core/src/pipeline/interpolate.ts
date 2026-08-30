function singleTemplatePath(value: string): string | undefined {
  if (!value.startsWith('{{') || !value.endsWith('}}')) return undefined;
  const path = value.slice(2, -2);
  return path.length > 0 && !path.includes('}') ? path : undefined;
}

function interpolateString(value: string, vars: Record<string, unknown>): string {
  const pieces: string[] = [];
  let candidate = -1;
  let emitted = 0;
  let scan = 0;

  while (scan < value.length - 1) {
    if (value[scan] === '{' && value[scan + 1] === '{') {
      if (candidate === -1) candidate = scan;
      scan += 2;
      continue;
    }
    if (value[scan] === '}' && value[scan + 1] === '}') {
      if (candidate !== -1 && scan > candidate + 2) {
        const full = value.slice(candidate, scan + 2);
        const path = value.slice(candidate + 2, scan).trim();
        const resolved = resolvePath(path, vars);
        pieces.push(value.slice(emitted, candidate));
        pieces.push(resolved === undefined ? full : String(resolved));
        emitted = scan + 2;
      }
      candidate = -1;
      scan += 2;
      continue;
    }
    if (value[scan] === '}') candidate = -1;
    scan += 1;
  }

  pieces.push(value.slice(emitted));
  return pieces.join('');
}

export function resolvePath(path: string, vars: Record<string, unknown>): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let cur: unknown = vars;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function interpolate<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const single = singleTemplatePath(value);
    if (single !== undefined) {
      const path = single.trim();
      return resolvePath(path, vars) as never as T;
    }
    return interpolateString(value, vars) as never as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolate(v, vars)) as never as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, vars);
    }
    return out as T;
  }
  return value;
}

export function evalCondition(expr: string, vars: Record<string, unknown>): boolean {
  const trimmed = expr.trim();
  const single = singleTemplatePath(trimmed);
  const path = single !== undefined ? single.trim() : trimmed;
  const value = resolvePath(path, vars);
  return Boolean(value);
}
