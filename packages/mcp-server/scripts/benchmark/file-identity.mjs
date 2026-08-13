/**
 * Compare a path stat with the stat obtained from an open descriptor.
 *
 * Windows Node 22 reports a zero device number for path-based `lstat()` but
 * the real device number for `FileHandle.stat()`. The inode/file-id remains
 * stable, so accept that narrowly documented representation difference while
 * still requiring the inode to match. Every other platform requires both
 * identity fields to match exactly.
 */
export function sameFileIdentity(expected, actual, platform = process.platform) {
  if (expected === null || typeof expected !== 'object') return false;
  if (actual === null || typeof actual !== 'object') return false;
  if (expected.ino !== actual.ino) return false;
  if (expected.dev === actual.dev) return true;
  return platform === 'win32' && expected.ino !== 0 && (expected.dev === 0 || actual.dev === 0);
}
