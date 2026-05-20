import { keccak256 } from 'viem';
import type { Payload } from './schema.js';

// byte-equivalent port of sdk/sdk/src/rsynth/payload.py::canonical_bytes.
// sorted keys at every depth, no whitespace, utf-8, no trailing newline.
// see sdk/SCHEMA.md §2 (v0.1.0, sha1 471308f9).

// float-typed leaf paths in PayloadSchema. python json.dumps writes integer-
// valued floats as "N.0"; JSON.stringify drops the .0. for cross-language
// hash parity, numbers at these paths are formatted with the .0 suffix when
// integer-valued. enforced against PayloadSchema by canonical-invariants.test.ts.
export const FLOAT_PATHS = new Set<string>([
  'duration_seconds',
  'score',
  'metrics.rmse',
  'metrics.jerk',
  'metrics.end_variance',
]);

export function canonicalBytes(payload: Payload): Uint8Array {
  return new TextEncoder().encode(canonicalize(payload, ''));
}

export function payloadHash(payload: Payload): `0x${string}` {
  return keccak256(canonicalBytes(payload));
}

function canonicalize(val: unknown, path: string): string {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (FLOAT_PATHS.has(path)) {
      return Number.isInteger(val) ? `${val}.0` : `${val}`;
    }
    return `${val}`;
  }
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) {
    return '[' + val.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            canonicalize(obj[k], path ? `${path}.${k}` : k),
        )
        .join(',') +
      '}'
    );
  }
  throw new Error(`canonicalize: unsupported type ${typeof val} at ${path}`);
}
