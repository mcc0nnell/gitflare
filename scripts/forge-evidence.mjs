/** Evidence bytes must be supplied by independent trusted storage, never the candidate checkout. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ID = /^[a-z][a-z0-9_.-]{0,63}$/;
export function isInside(parent, child) {
  const root = resolve(parent), file = resolve(child);
  return file === root || file.startsWith(root + sep);
}

export function evidenceDigest(directory, id) {
  if (!ID.test(id ?? '')) throw new Error('INVALID_EVIDENCE_ID');
  if (!directory) throw new Error('EVIDENCE_DIR_REQUIRED');
  if (!lstatSync(directory).isDirectory()) throw new Error('EVIDENCE_DIR_NOT_DIRECTORY');
  const file = join(resolve(directory), id + '.log');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('EVIDENCE_NOT_REGULAR_FILE');
    return createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    closeSync(fd);
  }
}
