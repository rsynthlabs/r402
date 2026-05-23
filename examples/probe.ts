// probe — direct facilitator /verify call, bypasses r402 server middleware.
//
// purpose: surface the native facilitator error so we can see *why* our
// envelope is being rejected. the r402 server only echoes "x402 settlement
// failed" (opaque); the facilitator's /verify returns the actual
// invalidReason. /verify is read-only — no USDC is burned.
//
// run: npx tsx --env-file=.env examples/probe.ts

import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, LocalAccount } from 'viem';

const CHAIN_ID            = 8453;
const USDC_DOMAIN_NAME    = 'USD Coin';
const USDC_DOMAIN_VERSION = '2';

const R402_BASE        = (process.env.R402_BASE_URL ?? 'https://r402.rsynth.ai').replace(/\/$/, '');
const FACILITATOR_BASE = (process.env.FACILITATOR_URL ?? 'https://facilitator.openx402.ai').replace(/\/$/, '');

const C = {
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface PaymentRequirements {
  scheme:            string;
  network:           string;
  asset:             Hex;
  amount:            string;
  payTo:             Hex;
  maxTimeoutSeconds: number;
  extra:             Record<string, unknown>;
}

async function fetchRequirements(): Promise<PaymentRequirements> {
  const r = await fetch(`${R402_BASE}/api/anchor`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    '{}',
  });
  if (r.status !== 402) throw new Error(`expected 402 from r402, got ${r.status}`);
  const header = r.headers.get('payment-required');
  if (!header) throw new Error('no payment-required header on 402');
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as { accepts: PaymentRequirements[] };
  if (!decoded.accepts?.[0]) throw new Error('no accepts[0]');
  return decoded.accepts[0];
}

async function signAuthorization(account: LocalAccount, req: PaymentRequirements) {
  const validAfter  = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds);
  const nonce       = ('0x' + crypto.randomBytes(32).toString('hex')) as Hex;
  const value       = BigInt(req.amount);

  const sig = await account.signTypedData({
    domain: {
      name:              USDC_DOMAIN_NAME,
      version:           USDC_DOMAIN_VERSION,
      chainId:           CHAIN_ID,
      verifyingContract: req.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: { from: account.address, to: req.payTo, value, validAfter, validBefore, nonce },
  });

  return {
    sig,
    authorization: {
      from:        account.address,
      to:          req.payTo,
      value:       value.toString(),
      validAfter:  validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };
}

function indent(s: string, by = '     '): string {
  return s.split('\n').map((l) => by + l).join('\n');
}

async function main(): Promise<void> {
  const pk = (process.env.BUYER_PRIVATE_KEY ?? '').trim() as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(C.red('BUYER_PRIVATE_KEY missing or malformed.'));
    process.exit(1);
  }
  const account = privateKeyToAccount(pk);

  console.log();
  console.log(C.bold('r402 → facilitator direct probe'));
  console.log(`  buyer:       ${account.address}`);
  console.log(`  r402:        ${R402_BASE}`);
  console.log(`  facilitator: ${FACILITATOR_BASE}`);
  console.log();

  console.log(C.dim('1. fetching payment-required from r402...'));
  const req = await fetchRequirements();
  console.log(`   ${C.dim('paymentRequirements:')}`);
  console.log(indent(JSON.stringify(req, null, 2)));
  console.log();

  console.log(C.dim('2. signing EIP-3009 TransferWithAuthorization...'));
  const { sig, authorization } = await signAuthorization(account, req);
  console.log(`   ${C.dim('signature:')} ${sig.slice(0, 18)}...${sig.slice(-6)}`);
  console.log(`   ${C.dim('nonce:    ')} ${authorization.nonce.slice(0, 18)}...${authorization.nonce.slice(-6)}`);
  console.log();

  console.log(C.dim(`3. POST ${FACILITATOR_BASE}/verify (read-only)...`));
  const verifyBody = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted:    req,
      payload:     { signature: sig, authorization },
    },
    paymentRequirements: req,
  };
  console.log(`   ${C.dim('verify-request body:')}`);
  console.log(indent(JSON.stringify(verifyBody, null, 2)));
  console.log();

  const resp = await fetch(`${FACILITATOR_BASE}/verify`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(verifyBody),
  });
  const text = await resp.text();

  console.log(C.dim('4. response:'));
  console.log(`   ${C.dim('status:')}  ${resp.status} ${resp.statusText}`);
  console.log(`   ${C.dim('headers:')}`);
  for (const [k, v] of resp.headers) console.log(`     ${k}: ${v}`);
  console.log(`   ${C.dim('body:')}`);
  try {
    const parsed = JSON.parse(text);
    console.log(indent(JSON.stringify(parsed, null, 2)));
    if (parsed.isValid === true) {
      console.log();
      console.log(C.green('  ✓ facilitator accepts the envelope.'));
      console.log(C.dim('  → r402↔buyer transport is the remaining suspect (header name, decode path).'));
    } else if (parsed.invalidReason) {
      console.log();
      console.log(C.red(`  ✗ facilitator rejected: ${parsed.invalidReason}`));
      if (parsed.invalidMessage) console.log(C.dim(`     ${parsed.invalidMessage}`));
    }
  } catch {
    console.log(`     ${text}`);
  }
  console.log();
}

main().catch((err) => {
  console.error(C.red('probe failed:'), err instanceof Error ? err.message : err);
  process.exit(99);
});
