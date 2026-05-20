import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PINNED_SHA1 = '471308f9dd73d09d22e090f31bdf7c587e47e6c0';
const SCHEMA_PATH = resolve(import.meta.dirname, '../../sdk/SCHEMA.md');
const AVAILABLE = existsSync(SCHEMA_PATH);

if (!AVAILABLE) {
  console.warn(
    `[schema-drift] sdk/SCHEMA.md not found at ${SCHEMA_PATH} — drift check skipped`,
  );
}

describe('schema drift (sdk/SCHEMA.md)', () => {
  it.skipIf(!AVAILABLE)('sha1 matches pinned value', () => {
    const sha1 = createHash('sha1').update(readFileSync(SCHEMA_PATH)).digest('hex');
    expect(sha1).toBe(PINNED_SHA1);
  });
});
