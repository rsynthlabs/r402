import { describe, it, expect } from 'vitest';
import { canonicalBytes, payloadHash } from '../src/canonical.js';
import { PayloadSchema, type Payload } from '../src/schema.js';

// mirrors sdk/sdk/tests/test_payload.py::SCHEMA_EXAMPLE
const SCHEMA_EXAMPLE: Payload = {
  version: '0.1.0',
  agent_id: 10311,
  robot_id: 'roarm-m3-01',
  episode_id: 'ep_2026-05-14_18-22-31_004a',
  task: 'pick and place the cube',
  started_at: '2026-05-14T18:22:31Z',
  ended_at: '2026-05-14T18:22:53Z',
  duration_seconds: 22.6,
  frames: 678,
  metrics: { rmse: 4.583, jerk: 2434753.0, end_variance: 0.0 },
  score: 0.9,
  outcome: 'SUCCESS',
};

const SCHEMA_EXAMPLE_HASH =
  '0x26444c4ba73c1f692533ddcf1827e56f5cefe27cbbd169c87ff11c443e99aa8d';

describe('canonical_bytes (sdk parity)', () => {
  it('SCHEMA_EXAMPLE hash matches sdk fixture', () => {
    expect(payloadHash(SCHEMA_EXAMPLE)).toBe(SCHEMA_EXAMPLE_HASH);
  });

  it('emits no whitespace between tokens', () => {
    // whitespace inside JSON string literals is fine; only inter-token whitespace is forbidden.
    const s = new TextDecoder().decode(canonicalBytes(SCHEMA_EXAMPLE));
    const stripped = s.replace(/"(?:\\.|[^"\\])*"/g, '""');
    expect(stripped).not.toMatch(/\s/);
  });

  it('sorts keys at every depth', () => {
    const s = new TextDecoder().decode(canonicalBytes(SCHEMA_EXAMPLE));
    expect(s.indexOf('"agent_id"')).toBeLessThan(s.indexOf('"version"'));
    expect(s.indexOf('"end_variance"')).toBeLessThan(s.indexOf('"jerk"'));
    expect(s.indexOf('"jerk"')).toBeLessThan(s.indexOf('"rmse"'));
  });

  it('emits no trailing newline', () => {
    const b = canonicalBytes(SCHEMA_EXAMPLE);
    expect(b[b.length - 1]).not.toBe(0x0a);
  });

  it('preserves utf-8 in strings', () => {
    const p: Payload = { ...SCHEMA_EXAMPLE, robot_id: '机器人-01' };
    const s = new TextDecoder().decode(canonicalBytes(p));
    expect(s).toContain('机器人-01');
  });

  it('PayloadSchema parses SCHEMA_EXAMPLE', () => {
    expect(() => PayloadSchema.parse(SCHEMA_EXAMPLE)).not.toThrow();
  });
});
