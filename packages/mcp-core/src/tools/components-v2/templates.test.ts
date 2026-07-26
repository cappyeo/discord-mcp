import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { interpolateTemplate } from './_lib/interpolate.js';
import { validateComponentsV2 } from './_lib/validator.js';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

interface TemplateFile {
  variables: string[];
  components: unknown[];
}

/** Plausible value for a declared template variable (URL-shaped where required). */
function sampleValue(name: string): string {
  return name.endsWith('url') ? 'https://example.com/sample.png' : `sample_${name}`;
}

describe('shipped Components V2 templates', () => {
  it('every template passes validateComponentsV2 after interpolation', async () => {
    const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const parsed = JSON.parse(await readFile(join(TEMPLATES_DIR, file), 'utf8')) as TemplateFile;
      const vars = Object.fromEntries(parsed.variables.map((v) => [v, sampleValue(v)]));
      const result = validateComponentsV2(interpolateTemplate(parsed.components, vars));
      expect({ file, issues: result.issues }).toEqual({ file, issues: [] });
    }
  });
});
