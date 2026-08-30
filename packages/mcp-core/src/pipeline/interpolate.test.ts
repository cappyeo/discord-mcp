import { describe, expect, it } from 'vitest';
import { evalCondition, interpolate, resolvePath } from './interpolate.js';

describe('resolvePath', () => {
  const vars = {
    step1: { id: 'msg_123', author: { name: 'alice' }, items: ['a', 'b', 'c'] },
    counter: 5,
  };

  it('resolves a simple key', () => {
    expect(resolvePath('counter', vars)).toBe(5);
  });

  it('resolves a nested object path with dots', () => {
    expect(resolvePath('step1.id', vars)).toBe('msg_123');
    expect(resolvePath('step1.author.name', vars)).toBe('alice');
  });

  it('resolves an array index with bracket notation', () => {
    expect(resolvePath('step1.items[0]', vars)).toBe('a');
    expect(resolvePath('step1.items[2]', vars)).toBe('c');
  });

  it('returns undefined for a missing path', () => {
    expect(resolvePath('step1.missing', vars)).toBeUndefined();
    expect(resolvePath('absent.path', vars)).toBeUndefined();
  });

  it('returns undefined for a path that goes through null/undefined', () => {
    expect(resolvePath('step1.author.deep.deeper', vars)).toBeUndefined();
  });
});

describe('interpolate', () => {
  const vars = {
    step1: { id: 'msg_123', count: 5 },
    step2: { url: 'https://example.com' },
    'step{3': { id: 'brace-compatible' },
  };

  it('returns raw value (type-preserved) when entire string is a single template', () => {
    expect(interpolate('{{step1.id}}', vars)).toBe('msg_123');
    expect(interpolate('{{step1.count}}', vars)).toBe(5);
  });

  it('stringifies and concatenates multi-template strings', () => {
    expect(interpolate('count is {{step1.count}}', vars)).toBe('count is 5');
    expect(interpolate('{{step1.id}} at {{step2.url}}', vars)).toBe(
      'msg_123 at https://example.com',
    );
  });

  it('leaves missing variables as the literal placeholder in mixed strings', () => {
    expect(interpolate('hello {{absent.var}}', vars)).toBe('hello {{absent.var}}');
  });

  it('preserves the existing support for opening braces inside a path', () => {
    expect(interpolate('{{step{3.id}}', vars)).toBe('brace-compatible');
    expect(interpolate('value={{step{3.id}}', vars)).toBe('value=brace-compatible');
  });

  it('returns undefined when a single-template references a missing path', () => {
    expect(interpolate('{{absent.var}}', vars)).toBeUndefined();
  });

  it('recurses into objects', () => {
    const out = interpolate({ a: '{{step1.id}}', b: 'plain' }, vars);
    expect(out).toEqual({ a: 'msg_123', b: 'plain' });
  });

  it('recurses into arrays', () => {
    const out = interpolate(['{{step1.id}}', 'plain', '{{step2.url}}'], vars);
    expect(out).toEqual(['msg_123', 'plain', 'https://example.com']);
  });

  it('does not interpolate non-string primitives', () => {
    expect(interpolate({ n: 42, b: true, nul: null }, vars)).toEqual({ n: 42, b: true, nul: null });
  });

  it('handles a long unterminated template prefix without regex backtracking', () => {
    const hostile = '{{'.repeat(20_000);
    expect(interpolate(hostile, vars)).toBe(hostile);
  });
});

describe('evalCondition', () => {
  const vars = {
    step1: { has_items: true, count: 0, name: '' },
    step2: { count: 5 },
  };

  it('returns true for a truthy path', () => {
    expect(evalCondition('{{step1.has_items}}', vars)).toBe(true);
    expect(evalCondition('{{step2.count}}', vars)).toBe(true);
  });

  it('returns false for a falsy path', () => {
    expect(evalCondition('{{step1.count}}', vars)).toBe(false);
    expect(evalCondition('{{step1.name}}', vars)).toBe(false);
    expect(evalCondition('{{absent.path}}', vars)).toBe(false);
  });

  it('strips outer {{ }} if present', () => {
    expect(evalCondition('step1.has_items', vars)).toBe(true);
  });
});
