// buyer-side roundtrip against live r402 (base mainnet).
//
// pays real USDC on base mainnet via x402, anchors a signed payload, then
// verifies the result through the same gate. costs ~$2 USDC per run.
//
// implementation note: x402-fetch (npm v1.x) speaks the v1 protocol with bare
// network names ('base', 'base-sepolia'). r402 emits the v2 protocol with
// CAIP-2 network ids ('eip155:8453') and payment requirements in the
// payment-required HEADER, not the body. so this script does the EIP-3009
// flow manually with viem's signTypedData. when an SDK lands that speaks
// x402Version=2 against @x402/core v2.x, swap this for ~5 lines.
//
// run: npx tsx --env-file=.env examples/buyer.ts

import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, LocalAccount } from 'viem';
import { payloadHash } from '../src/canonical.js';
import { PayloadSchema, type Payload } from '../src/schema.js';

const CHAIN_ID = 8453;
// TODO: read these from accept.extra on each 402 response instead of
// hardcoding here. the server pins them in its accepts config and they
// flow through to the buyer in the payment-required envelope's
// accepts[].extra — sourcing from there would survive a future domain
// rotation (e.g. usdc v3) without a buyer redeploy. left hardcoded for
// now so the buyer stays simple and matches what the server pins.
const USDC_DOMAIN_NAME    = 'USD Coin';
const USDC_DOMAIN_VERSION = '2';

const C = {
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface AnchorResponse {
  signer:      Hex;
  payloadHash: Hex;
  signature:   Hex;
  txHash:      Hex;
  blockNumber: string;
  anchorUrl:   string;
}

export interface VerifyResponse {
  signer:      Hex;
  payloadHash: Hex;
  signature:   Hex;
  timestamp:   string;
  blockNumber: string;
  txHash:      Hex;
}

interface PaymentRequirements {
  scheme:            string;
  network:           string;
  asset:             Hex;
  amount:            string;
  payTo:             Hex;
  maxTimeoutSeconds: number;
  extra:             Record<string, unknown>;
}

interface PaymentRequired {
  x402Version: number;
  accepts:     PaymentRequirements[];
  resource?:   unknown;
  error?:      string;
}

class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

class X402Rejected extends Error {
  constructor(public required: PaymentRequired | null) {
    super('payment proof rejected after retry');
  }
}

function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 10)}...${hex.slice(-4)}` : hex;
}

function buildPayload(): Payload {
  const ended   = new Date();
  const started = new Date(ended.getTime() - 1000);
  const payload: Payload = {
    version:          '0.1.0',
    agent_id:         1,
    robot_id:         'buyer-demo-bot',
    episode_id:       `buyer-roundtrip-${Date.now()}`,
    task:             'mainnet x402 roundtrip',
    started_at:       started.toISOString(),
    ended_at:         ended.toISOString(),
    duration_seconds: 1.0,
    frames:           1,
    metrics:          { rmse: 0.0, jerk: 0.0, end_variance: 0.0 },
    score:            1.0,
    outcome:          'SUCCESS',
  };
  return PayloadSchema.parse(payload);
}

function decodeRequired(headerB64: string | null): PaymentRequired | null {
  if (!headerB64) return null;
  try {
    return JSON.parse(Buffer.from(headerB64, 'base64').toString('utf-8')) as PaymentRequired;
  } catch { return null; }
}

async function signAuthorization(
  account: LocalAccount,
  req: PaymentRequirements,
): Promise<{ sig: Hex; authorization: ExactAuthorization }> {
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
    message: {
      from:  account.address,
      to:    req.payTo,
      value,
      validAfter,
      validBefore,
      nonce,
    },
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

interface ExactAuthorization {
  from:        Hex;
  to:          Hex;
  value:       string;
  validAfter:  string;
  validBefore: string;
  nonce:       Hex;
}

export async function callWithX402<T>(
  url: string,
  method: 'GET' | 'POST',
  body: unknown,
  account: LocalAccount,
): Promise<T> {
  const baseHeaders: Record<string, string> = body !== undefined ? { 'content-type': 'application/json' } : {};
  const baseInit: RequestInit = {
    method,
    headers: baseHeaders,
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  };

  const first = await fetch(url, baseInit);
  if (first.status !== 402) {
    if (!first.ok) throw new HttpError(first.status, await first.text());
    return (await first.json()) as T;
  }

  const required = decodeRequired(first.headers.get('payment-required'));
  const accept   = required?.accepts?.[0];
  if (!accept) throw new Error('402 without decodable payment-required accepts[]');
  if (accept.scheme !== 'exact') throw new Error(`unsupported scheme: ${accept.scheme}`);

  const { sig, authorization } = await signAuthorization(account, accept);

  const envelope = {
    x402Version: required!.x402Version,
    accepted:    accept,
    payload:     { signature: sig, authorization },
  };
  const xPayment = Buffer.from(JSON.stringify(envelope), 'utf-8').toString('base64');

  // @x402/core extractPayment honors only "payment-signature" (and its
  // uppercase variant) — the v1 legacy "x-payment" header is dead code in
  // node_modules/@x402/express but never reaches the decode path. see
  // x402HTTPResourceServer.extractPayment in @x402/core/dist/cjs/server.
  const retry = await fetch(url, {
    ...baseInit,
    headers: { ...baseHeaders, 'payment-signature': xPayment },
  });
  if (retry.status === 402) {
    throw new X402Rejected(decodeRequired(retry.headers.get('payment-required')));
  }
  if (!retry.ok) throw new HttpError(retry.status, await retry.text());
  return (await retry.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const pk      = (process.env.BUYER_PRIVATE_KEY ?? '').trim() as Hex;
  const baseUrl = (process.env.R402_BASE_URL ?? 'https://r402.rsynth.ai').replace(/\/$/, '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(C.red('BUYER_PRIVATE_KEY missing or malformed (need 0x + 64 hex).'));
    process.exit(1);
  }

  const account = privateKeyToAccount(pk);
  const payload = buildPayload();
  const hash    = payloadHash(payload);
  const sig     = await account.signMessage({ message: { raw: hash } });

  console.log();
  console.log(C.bold('r402 buyer roundtrip — base mainnet'));
  console.log();
  console.log(`  buyer:   ${account.address}`);
  console.log(`  payload: agent_id=${payload.agent_id}, episode_id=${payload.episode_id}`);
  console.log(`  hash:    ${hash}`);
  console.log();

  // anchor
  console.log(`  ${C.dim('POST')} ${baseUrl}/api/anchor ${C.dim('(paying $1.00 USDC via x402)')}`);
  let anchored: AnchorResponse;
  try {
    anchored = await callWithX402<AnchorResponse>(
      `${baseUrl}/api/anchor`,
      'POST',
      { payload, signature: sig },
      account,
    );
  } catch (err) {
    if (err instanceof X402Rejected) {
      console.error(C.red('  402 after retry — payment proof rejected by the facilitator.'));
      if (err.required) console.error(C.dim('  payment-required:'), err.required);
      process.exit(1);
    }
    if (err instanceof HttpError) {
      console.error(C.red(`  anchor failed: ${err.status}`));
      console.error(C.dim(`  body: ${err.body}`));
      process.exit(2);
    }
    throw err;
  }
  console.log(`    → anchored: ${anchored.txHash}`);
  console.log(`    → block:    ${anchored.blockNumber}`);
  console.log(`    → basescan: ${anchored.anchorUrl}`);
  console.log();

  // verify (with one 5s retry on 404 to absorb RPC propagation lag)
  console.log(`  ${C.dim('GET')}  ${baseUrl}/api/verify/${short(anchored.txHash)} ${C.dim('(paying $1.00 USDC via x402)')}`);
  let verified: VerifyResponse;
  try {
    verified = await callWithX402<VerifyResponse>(
      `${baseUrl}/api/verify/${anchored.txHash}`,
      'GET',
      undefined,
      account,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      console.log(`    ${C.dim('verify 404 — waiting 5s for RPC propagation...')}`);
      await sleep(5000);
      verified = await callWithX402<VerifyResponse>(
        `${baseUrl}/api/verify/${anchored.txHash}`,
        'GET',
        undefined,
        account,
      );
    } else if (err instanceof X402Rejected) {
      console.error(C.red('  402 after retry — payment proof rejected by the facilitator.'));
      if (err.required) console.error(C.dim('  payment-required:'), err.required);
      process.exit(1);
    } else { throw err; }
  }

  const signerOk = verified!.signer.toLowerCase() === account.address.toLowerCase();
  const hashOk   = verified!.payloadHash === hash;
  console.log(`    → signer: ${verified!.signer} (match: ${signerOk ? C.green('ok') : C.red('FAIL')})`);
  console.log(`    → hash:   ${verified!.payloadHash} (match: ${hashOk ? C.green('ok') : C.red('FAIL')})`);
  console.log();

  if (!signerOk || !hashOk) {
    console.error(C.red(`  mismatch — expected signer=${account.address}, hash=${hash}`));
    process.exit(3);
  }

  console.log(`  ${C.bold('roundtrip complete.')} total: $2.00 USDC.`);
  console.log(`  ${C.green('paid. signed. proven.')}`);
  console.log();
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => {
  console.error(C.red('roundtrip failed:'), err instanceof Error ? err.message : err);
  process.exit(99);
});
