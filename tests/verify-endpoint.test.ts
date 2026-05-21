// 200-path and 400-path coverage lands W2 day 3-5 when buyer agent can craft x402 payment proofs.
//
// 402 tests run against Sepolia paywall (canonical x402.org facilitator).
// verify.ts logic targets Base mainnet — that flow is exercised by tests/verify.crosslang.test.ts
// + tests/verify.mainnet.test.ts (W2 day 1). Mainnet paywall flow deferred to W4
// (see src/server.ts header for upgrade path).
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

describe('server endpoints', () => {
  it('GET /health → 200 { status: "ok" }', async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/verify/:txHash without X-PAYMENT → 402', async () => {
    const txHash = `0x${'a'.repeat(64)}`;
    const r = await fetch(`${baseUrl}/api/verify/${txHash}`);
    expect(r.status).toBe(402);
  });

  it('GET /api/verify/<bad-format> without X-PAYMENT → still 402 (paywall before handler)', async () => {
    const r = await fetch(`${baseUrl}/api/verify/not-a-hash`);
    expect(r.status).toBe(402);
  });
});
