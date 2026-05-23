import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Hex } from 'viem';

// hoist the mock fn so the vi.mock factory below (which is hoisted itself)
// can close over the same instance the tests configure.
const { mockWriteContract } = vi.hoisted(() => ({
  mockWriteContract: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: () => ({ writeContract: mockWriteContract }),
  };
});

const {
  anchorViaHotWallet,
  RelayerError,
  RelayerTimeout,
} = await import('../src/relayer.js');

const PRIVATE_KEY  = ('0x' + 'a1'.repeat(32)) as Hex;
const RPC_URL      = 'https://example.invalid/rpc';
const PAYLOAD_HASH = ('0x' + 'a'.repeat(64))  as Hex;
const SIGNATURE    = ('0x' + 'b'.repeat(130)) as Hex;

beforeEach(() => {
  process.env.RELAYER_PRIVATE_KEY = PRIVATE_KEY;
  process.env.BASE_RPC_URL        = RPC_URL;
  mockWriteContract.mockReset();
});

afterEach(() => {
  delete process.env.RELAYER_PRIVATE_KEY;
  delete process.env.BASE_RPC_URL;
  delete process.env.RELAYER_TIMEOUT_MS;
});

describe('anchorViaHotWallet', () => {
  it('returns txHash when writeContract resolves', async () => {
    const TX = ('0x' + 'c'.repeat(64)) as Hex;
    mockWriteContract.mockResolvedValue(TX);

    const result = await anchorViaHotWallet({
      payloadHash: PAYLOAD_HASH,
      signature:   SIGNATURE,
    });

    expect(result.txHash).toBe(TX);
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    const call = mockWriteContract.mock.calls[0][0];
    expect(call.functionName).toBe('record');
    expect(call.args).toEqual([PAYLOAD_HASH, SIGNATURE]);
  });

  it('throws RelayerError when writeContract rejects (RPC-style)', async () => {
    mockWriteContract.mockRejectedValue(new Error('rpc fetch failed'));

    await expect(
      anchorViaHotWallet({ payloadHash: PAYLOAD_HASH, signature: SIGNATURE }),
    ).rejects.toBeInstanceOf(RelayerError);
  });

  it('throws RelayerTimeout when writeContract stays pending past deadline', async () => {
    vi.useFakeTimers();
    mockWriteContract.mockReturnValue(new Promise(() => { /* never resolves */ }));

    const promise = anchorViaHotWallet({
      payloadHash: PAYLOAD_HASH,
      signature:   SIGNATURE,
      timeoutMs:   1000,
    });

    // surface unhandled-rejection warnings inside the assertion, not before.
    promise.catch(() => { /* swallow until assertion */ });

    await vi.advanceTimersByTimeAsync(1500);
    await expect(promise).rejects.toBeInstanceOf(RelayerTimeout);

    vi.useRealTimers();
  });
});
