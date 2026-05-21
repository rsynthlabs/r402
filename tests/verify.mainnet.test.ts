import { describe, it, expect } from 'vitest';
import { verifyAnchor } from '../src/verify.js';

const RPC = process.env.BASE_RPC_URL;

const FIRST_ANCHOR_TX =
  '0x713cf782481db82785853a56cb2b52f04fbfcc535d3bf9ffc1636f5c493cd7fb' as const;
const EXPECTED_SIGNER = '0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe';
const EXPECTED_HASH =
  '0xf4956c73088b2e375ae322a452d80fdd52634707288820916eb01445f4a92b12';
const EXPECTED_BLOCK = 46166628n;
const EXPECTED_TIMESTAMP = 1779122603n;

describe('verify (base mainnet)', () => {
  it.skipIf(!RPC)('verifies first anchor on base mainnet', async () => {
    const result = await verifyAnchor(FIRST_ANCHOR_TX, RPC!);
    expect(result.signer.toLowerCase()).toBe(EXPECTED_SIGNER.toLowerCase());
    expect(result.payloadHash).toBe(EXPECTED_HASH);
    expect(result.blockNumber).toBe(EXPECTED_BLOCK);
    expect(result.timestamp).toBe(EXPECTED_TIMESTAMP);
    expect(result.txHash).toBe(FIRST_ANCHOR_TX);
  });
});
