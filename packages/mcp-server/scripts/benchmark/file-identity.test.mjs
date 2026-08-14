import { describe, expect, it } from 'vitest';
import { sameFileIdentity } from './file-identity.mjs';

describe('descriptor file identity', () => {
  it('requires matching device and inode by default', () => {
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }, 'linux')).toBe(true);
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 2, ino: 2 }, 'linux')).toBe(false);
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }, 'linux')).toBe(false);
  });

  it('accepts only the Windows zero-device representation with a stable inode', () => {
    expect(sameFileIdentity({ dev: 0, ino: 2 }, { dev: 42, ino: 2 }, 'win32')).toBe(true);
    expect(sameFileIdentity({ dev: 42, ino: 2 }, { dev: 0, ino: 2 }, 'win32')).toBe(true);
    expect(sameFileIdentity({ dev: 0, ino: 0 }, { dev: 42, ino: 0 }, 'win32')).toBe(false);
    expect(sameFileIdentity({ dev: 42, ino: 0 }, { dev: 42, ino: 0 }, 'win32')).toBe(false);
    expect(sameFileIdentity({ dev: 0, ino: 2 }, { dev: 42, ino: 3 }, 'win32')).toBe(false);
  });

  it('fails closed for malformed stat values', () => {
    expect(sameFileIdentity(null, { dev: 1, ino: 2 }, 'win32')).toBe(false);
    expect(sameFileIdentity({ dev: 1, ino: 2 }, undefined, 'win32')).toBe(false);
  });
});
