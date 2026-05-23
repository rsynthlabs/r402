import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  anchorViaOneShot,
  OneShotError,
  OneShotTimeout,
} from '../src/relayer.js';

const API_KEY      = 'test-key';
const METHOD_URL   = 'https://api.1shotapi.com/v1/methods/test-id';
const PAYLOAD_HASH = ('0x' + 'a'.repeat(64)) as Hex;
const SIGNATURE    = ('0x' + 'b'.repeat(130)) as Hex;

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.ONESHOT_API_KEY    = API_KEY;
  process.env.ONESHOT_METHOD_URL = METHOD_URL;
});

afterEach(() => {
  delete process.env.ONESHOT_API_KEY;
  delete process.env.ONESHOT_METHOD_URL;
  delete process.env.ONESHOT_TIMEOUT_MS;
  vi.unstubAllGlobals();
});

describe('anchorViaOneShot', () => {
  it('returns txHash after pending → confirmed polling', async () => {
    const TX = ('0x' + 'c'.repeat(64)) as Hex;
    let pollN = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: { method?: string }) => {
      if (init?.method === 'POST') return jsonRes(200, { execution_id: 'exec-1' });
      pollN += 1;
      if (pollN === 1) return jsonRes(200, { status: 'pending' });
      return jsonRes(200, { status: 'confirmed', transaction_hash: TX });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await anchorViaOneShot({
      payloadHash:    PAYLOAD_HASH,
      signature:      SIGNATURE,
      timeoutMs:      500,
      pollIntervalMs: 5,
    });

    expect(result.txHash).toBe(TX);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 POST + 2 polls
  });

  it('throws OneShotTimeout when status never reaches confirmed', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: { method?: string }) => {
      if (init?.method === 'POST') return jsonRes(200, { execution_id: 'exec-stuck' });
      return jsonRes(200, { status: 'pending' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      anchorViaOneShot({
        payloadHash:    PAYLOAD_HASH,
        signature:      SIGNATURE,
        timeoutMs:      30,
        pollIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(OneShotTimeout);
  });

  it('throws OneShotError when POST returns non-2xx', async () => {
    const fetchMock = vi.fn(async () => jsonRes(500, { error: 'internal' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      anchorViaOneShot({
        payloadHash: PAYLOAD_HASH,
        signature:   SIGNATURE,
      }),
    ).rejects.toBeInstanceOf(OneShotError);
  });
});
