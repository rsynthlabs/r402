// 200-path and 400-path coverage for /api/anchor lands when the buyer agent
// can craft x402 payment proofs — same gate as tests/verify-endpoint.test.ts.
// the ServerOptions.anchor injection point in src/server.ts makes those
// tests trivial once that lands.
//
// for now: only the paywall posture is reachable, mirroring the existing
// verify-endpoint test pattern (verify-endpoint.test.ts:52-61).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { createServer } from '../src/server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port bound');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
);

describe('POST /api/anchor', () => {
  it('without X-PAYMENT → 402', async () => {
    const r = await fetch(`${baseUrl}/api/anchor`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ payload: {}, signature: '0x' + 'a'.repeat(130) }),
    });
    expect(r.status).toBe(402);
  });

  it('with valid JSON but wrong shape and no payment → still 402 (paywall before zod)', async () => {
    const r = await fetch(`${baseUrl}/api/anchor`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ not_a_payload: true }),
    });
    expect(r.status).toBe(402);
  });
});
