import { describe, expect, it } from 'vitest';
import { getToolDetailContext } from '../src/components/starlight/toolNavigation';

describe('tool detail navigation context', () => {
  it.each([
    ['tools/messages/send', 'messages', 'Messages'],
    ['tools/components_v2/send.mdx', 'components_v2', 'Components v2'],
    ['/tools/app_emojis/create/', 'app_emojis', 'App emojis'],
  ])('parses %s', (routeId, category, categoryLabel) => {
    expect(getToolDetailContext(routeId)).toEqual({ category, categoryLabel });
  });

  it.each([
    'tools',
    'tools/messages',
    'tools/messages/send/extra',
    'reference/cli',
  ])('ignores non-detail route %s', (routeId) => {
    expect(getToolDetailContext(routeId)).toBeUndefined();
  });
});
