// cold-boot regression lock for the pinned facilitator (src/server.ts).
//
// the prod cold-boot 500 ("exit-128") was the facilitator GET /supported egress
// gating the first 402: x402ResourceServer.buildPaymentRequirements throws
// without a supported-kind, @x402/express fetches kinds via getSupported() as a
// floating promise at construction awaited on the first request, and on a cold
// lambda that fetch fails/rejects -> 500/502 or a worker-killing unhandled
// rejection. the fix pins getSupported() to a fixed value with zero i/o, so the
// first 402 builds with no facilitator network call. this test asserts exactly
// that: a cold request builds the 402 + bazaar envelope while ZERO fetches hit
// the facilitator, and locks the pinned kinds so drift breaks loudly.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { createServer, PINNED_SUPPORTED } from '../src/server.js';

const GENESIS_SIGNER = '0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe';
const GENESIS_TXHASH = '0x713cf782481db82785853a56cb2b52f04fbfcc535d3bf9ffc1636f5c493cd7fb';
const NETWORK_ID = 'eip155:8453';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE_AMOUNT = '1000000';
const PAY_TO = '0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F';

// any call to one of these is facilitator egress; the local server request
// (127.0.0.1) is not.
const isFacilitatorEgress = (url: string) =>
  url.includes('/supported') || url.includes('openx402');

let server: Server;
let baseUrl: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  // spy BEFORE createServer so construction-time initialize() is observed too.
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port bound');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('pinned facilitator — cold boot does no facilitator egress', () => {
  it('builds the 402 + bazaar envelope with ZERO facilitator fetch', async () => {
    const txHash = `0x${'a'.repeat(64)}`;
    const r = await fetch(`${baseUrl}/verify/${txHash}`);
    expect(r.status).toBe(402);

    const header = r.headers.get('payment-required');
    expect(header).toBeTruthy();
    const envelope = JSON.parse(Buffer.from(header!, 'base64').toString()) as {
      x402Version?: number;
      accepts?: Array<{ scheme?: string; network?: string; asset?: string; amount?: string; payTo?: string }>;
      extensions?: {
        bazaar?: {
          info?: { input?: Record<string, unknown>; output?: { example?: Record<string, unknown> } };
          routeTemplate?: string;
        };
      };
    };
    expect(envelope.x402Version).toBe(2);
    const accepts = envelope.accepts ?? [];
    expect(accepts.length).toBeGreaterThan(0);
    const req = accepts[0];
    expect(req?.scheme).toBe('exact');
    expect(req?.network).toBe(NETWORK_ID);
    expect(req?.asset?.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(req?.amount).toBe(PRICE_AMOUNT);
    expect(req?.payTo?.toLowerCase()).toBe(PAY_TO.toLowerCase());

    const bazaar = envelope.extensions?.bazaar;
    expect(bazaar).toBeDefined();
    expect(bazaar?.info?.input?.type).toBe('http');
    expect(bazaar?.info?.input?.method).toBe('GET');
    expect(bazaar?.info?.input?.pathParams).toEqual({ txHash });
    expect(bazaar?.routeTemplate).toBe('/verify/:txHash');
    expect(bazaar?.info?.output?.example).toMatchObject({
      signer: GENESIS_SIGNER,
      txHash: GENESIS_TXHASH,
    });

    // the heart of the fix: nothing reached the facilitator. the only fetch(es)
    // are the local 127.0.0.1 request above.
    const egressCalls = fetchSpy.mock.calls
      .map(([input]) => (typeof input === 'string' ? input : String((input as Request).url ?? input)))
      .filter(isFacilitatorEgress);
    expect(egressCalls).toEqual([]);
  });
});

describe('pinned facilitator — supported kinds are locked', () => {
  // drift guard: if OpenX402 changes its Base supported set, re-capture and
  // update both the pin and this assertion deliberately.
  it('PINNED_SUPPORTED is the captured Base exact v2 kind', () => {
    expect(PINNED_SUPPORTED).toEqual({
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'eip155:8453',
          extra: {
            name: 'USD Coin',
            version: '2',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            assetTransferMethod: 'eip3009',
          },
        },
      ],
      extensions: ['discovery'],
      signers: { 'eip155:*': ['0x97316FA4730BC7d3B295234F8e4D04a0a4C093e8'] },
    });
  });
});
