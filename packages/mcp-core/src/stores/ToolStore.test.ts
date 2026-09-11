import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolStore } from './ToolStore.js';

describe('ToolStore', () => {
  it('exposes store name "tools"', () => {
    const store = new ToolStore();
    expect(store.name).toBe('tools');
  });
  it('starts empty', () => {
    const store = new ToolStore();
    expect(store.size).toBe(0);
  });

  it.each([
    '_lib/helper.js',
    'nested/_lib/helper.js',
    'send.test.js',
    'send.spec.mjs',
  ])('does not load helper or test module %s', (path) => {
    expect(new ToolStore().strategy.filter(join('tools', path))).toBeNull();
  });

  it('loads tool modules while retaining the default extension filter', () => {
    const store = new ToolStore();
    const path = join('tools', 'messages', 'send.js');
    expect(store.strategy.filter(path)).toEqual({ path, name: 'send', extension: '.js' });
    expect(store.strategy.filter(join('tools', 'README.md'))).toBeNull();
  });
});
