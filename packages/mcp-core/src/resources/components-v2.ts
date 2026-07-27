import { z } from 'zod';
import { ComponentsV2Array } from '../tools/components-v2/_lib/schema.js';
import { TEMPLATE_NAMES, TEMPLATES } from '../tools/components-v2/templates/index.js';

const SCHEMA_URI = 'discord://components-v2/schema';
const TEMPLATE_URI_PREFIX = 'discord://components-v2/templates/';

export interface V2ResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface V2ResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export async function listV2Resources(): Promise<readonly V2ResourceEntry[]> {
  const templates = TEMPLATE_NAMES.map((name) => ({
    uri: `${TEMPLATE_URI_PREFIX}${name}`,
    name: `Components V2 template — ${name}`,
    description: `Pre-built Components V2 layout for ${name}. Apply via components_v2_send_from_template.`,
    mimeType: 'application/json',
  }));
  return [
    {
      uri: SCHEMA_URI,
      name: 'Components V2 JSON Schema',
      description: 'JSON Schema (draft-2020-12) for the Components V2 component types.',
      mimeType: 'application/json',
    },
    ...templates,
  ];
}

export async function readV2Resource(uri: string): Promise<V2ResourceContent | null> {
  if (uri === SCHEMA_URI) {
    const json = z.toJSONSchema(ComponentsV2Array, { target: 'draft-2020-12' });
    return { uri, mimeType: 'application/json', text: JSON.stringify(json, null, 2) };
  }
  if (uri.startsWith(TEMPLATE_URI_PREFIX)) {
    const name = uri.slice(TEMPLATE_URI_PREFIX.length);
    // Registry lookup rather than a filesystem read: no path to traverse, and
    // an unknown name is a miss instead of a caught ENOENT.
    const template = Object.hasOwn(TEMPLATES, name) ? TEMPLATES[name] : undefined;
    if (template === undefined) return null;
    return { uri, mimeType: 'application/json', text: JSON.stringify(template, null, 2) };
  }
  return null;
}
