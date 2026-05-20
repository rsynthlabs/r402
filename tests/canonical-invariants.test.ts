import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PayloadSchema } from '../src/schema.js';
import { FLOAT_PATHS } from '../src/canonical.js';

// walks PayloadSchema and collects every leaf where the schema is a
// plain z.number() (float). z.int() in zod v4 returns a ZodNumberFormat
// instance — instanceof z.ZodNumber is true but _def.format identifies it
// as integer-shaped. .min()/.max() on z.number() preserves a plain ZodNumber
// with format undefined, so `score` is included correctly.
const INT_FORMATS = new Set([
  'int',
  'safeint',
  'int32',
  'int64',
  'uint32',
  'uint64',
]);

function collectFloatPaths(schema: z.ZodType): Set<string> {
  const out = new Set<string>();

  function walk(node: z.ZodType, path: string) {
    let cur: z.ZodType = node;
    while (
      cur != null &&
      typeof cur === 'object' &&
      '_def' in cur &&
      cur._def != null &&
      typeof cur._def === 'object' &&
      'innerType' in cur._def &&
      cur._def.innerType
    ) {
      cur = cur._def.innerType as z.ZodType;
    }

    if (cur instanceof z.ZodObject) {
      const shape = (cur as z.ZodObject<z.ZodRawShape>).shape;
      for (const [k, child] of Object.entries(shape)) {
        walk(child as z.ZodType, path ? `${path}.${k}` : k);
      }
      return;
    }

    if (cur instanceof z.ZodNumber) {
      const fmt = (cur._def as { format?: string }).format;
      if (!fmt || !INT_FORMATS.has(fmt)) {
        out.add(path);
      }
    }
  }

  walk(schema, '');
  return out;
}

describe('canonical invariants', () => {
  it('FLOAT_PATHS matches z.number() leaves derived from PayloadSchema', () => {
    const derived = collectFloatPaths(PayloadSchema);
    expect([...derived].sort()).toEqual([...FLOAT_PATHS].sort());
  });
});
