import express, { type Express, type Request, type Response } from 'express';
import { paymentMiddleware } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from '@x402/extensions/bazaar';
import { z } from 'zod';
import {
  createPublicClient,
  http,
  recoverMessageAddress,
  WaitForTransactionReceiptTimeoutError,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { verifyAnchor } from './verify.js';
import { payloadHash } from './canonical.js';
import { PayloadSchema } from './schema.js';
import {
  anchorViaHotWallet,
  RelayerReverted,
  RelayerTimeout,
  type AnchorParams,
  type AnchorResult,
} from './relayer.js';

// x402 paywall: base mainnet via OpenX402 facilitator
// (https://facilitator.openx402.ai). permissionless, no KYC, no API keys,
// no fees; listed on x402scan.com, open source at github.com/openx402/openx402.
//
// real USDC settles to PAY_TO on base mainnet — production, not testnet.
// ExecutionLog.record() also writes to base mainnet via the hot-wallet
// relayer in src/relayer.ts; single network end-to-end.
//
// override the facilitator with FACILITATOR_URL env for self-hosted or
// alternative permissionless deployments. PRICE is pinned to base mainnet
// USDC (atomic units; 1_000_000 = 1.00) so a facilitator swap can't
// silently re-asset the route.
const PAY_TO          = '0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F';
const USDC_BASE       = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE           = { asset: USDC_BASE, amount: '1000000' }; // $1.00 USDC
const NETWORK_ID      = 'eip155:8453';
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://facilitator.openx402.ai';

// USDC EIP-712 domain pin. base mainnet USDC.name() returns "USD Coin"
// (the sepolia contract returns "USDC" — different contract, different
// domain). when PRICE is the AssetAmount shape, @x402/express does not
// auto-fill these, so an empty `extra` leaves the facilitator to guess —
// any default mismatching this domain makes ECDSA recover a different
// address and the proof gets rejected after settlement.
const USDC_EIP712 = { name: 'USD Coin', version: '2' };

// duplicated from verify.ts (locked); keep in sync if ExecutionLog redeploys.
const EXECUTION_LOG_ADDRESS = '0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c';

// agentic.market bazaar discovery declaration for the verify routes. the
// output example is the genesis anchor (scripts/verify-genesis.ts), fetched
// once from the live ExecutionLog event so example and schema match the
// real 200 body byte-for-byte. method/routeTemplate/pathParams are filled
// per-request by bazaarResourceServerExtension.enrichDeclaration.
const VERIFY_DISCOVERY = declareDiscoveryExtension({
  pathParamsSchema: {
    properties: { txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } },
    required: ['txHash'],
  },
  output: {
    example: {
      signer:      '0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe',
      payloadHash: '0xf4956c73088b2e375ae322a452d80fdd52634707288820916eb01445f4a92b12',
      signature:   '0xd44fd6ccc4468252c4e790549fdf113b89b06afc7d4aeb265f8e5b693fd3b7216680fc03b15194241ee1cbc2f7d7c1037901d9406a9b3c13c70f46b23ed222911c',
      timestamp:   '1779122603',
      blockNumber: '46166628',
      txHash:      '0x713cf782481db82785853a56cb2b52f04fbfcc535d3bf9ffc1636f5c493cd7fb',
    },
    schema: {
      properties: {
        signer:      { type: 'string' },
        payloadHash: { type: 'string' },
        signature:   { type: 'string' },
        timestamp:   { type: 'string' },
        blockNumber: { type: 'string' },
        txHash:      { type: 'string' },
      },
      required: ['signer', 'payloadHash', 'signature', 'timestamp', 'blockNumber', 'txHash'],
    },
  },
});

const TxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const AnchorBodySchema = z.object({
  payload:   z.unknown(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type AnchorFn = (p: AnchorParams) => Promise<AnchorResult>;

export interface ServerOptions {
  anchor?: AnchorFn;
}

export function createServer(opts: ServerOptions = {}): Express {
  const anchor: AnchorFn = opts.anchor ?? anchorViaHotWallet;

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      contract: EXECUTION_LOG_ADDRESS,
      chain: 'base',
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
    });
  });

  app.get('/', (_req, res) => {
    res.redirect(302, 'https://github.com/rsynthlabs/r402');
  });

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK_ID, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  app.use(
    paymentMiddleware(
      {
        'GET /api/verify/:txHash': {
          accepts: {
            scheme:  'exact',
            price:   PRICE,
            network: NETWORK_ID,
            payTo:   PAY_TO,
            extra:   USDC_EIP712,
          },
          description: 'proof-of-execution verdict for $R robot/agent execution anchors on Base',
          extensions: VERIFY_DISCOVERY,
        },
        // prefix-free public alias of GET /api/verify/:txHash — same paywall,
        // same handler. read-only verify is a safe public surface; /api/anchor
        // (a write that burns relayer gas) is deliberately not aliased to root.
        'GET /verify/:txHash': {
          accepts: {
            scheme:  'exact',
            price:   PRICE,
            network: NETWORK_ID,
            payTo:   PAY_TO,
            extra:   USDC_EIP712,
          },
          description: 'proof-of-execution verdict for $R robot/agent execution anchors on Base',
          extensions: VERIFY_DISCOVERY,
        },
        'POST /api/anchor': {
          accepts: {
            scheme:  'exact',
            price:   PRICE,
            network: NETWORK_ID,
            payTo:   PAY_TO,
            extra:   USDC_EIP712,
          },
          description: 'anchor a signed $R execution proof to Base via r402 relayer',
        },
      },
      resourceServer,
    ),
  );

  app.get('/api/verify/:txHash', verifyHandler);
  app.get('/verify/:txHash', verifyHandler);
  app.post('/api/anchor', (req, res) => anchorHandler(req, res, anchor));

  return app;
}

async function verifyHandler(req: Request, res: Response): Promise<void> {
  const parsed = TxHashSchema.safeParse(req.params.txHash);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_tx_hash' });
    return;
  }

  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    res.status(500).json({ error: 'misconfigured', detail: 'BASE_RPC_URL not set' });
    return;
  }

  try {
    const r = await verifyAnchor(parsed.data as `0x${string}`, rpcUrl);
    res.status(200).json({
      signer:      r.signer,
      payloadHash: r.payloadHash,
      signature:   r.signature,
      timestamp:   r.timestamp.toString(),
      blockNumber: r.blockNumber.toString(),
      txHash:      r.txHash,
    });
  } catch (err) {
    res.status(mapVerifyError(err)).json({
      error: 'verify_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function mapVerifyError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('reverted')) return 404;
  if (msg.includes('TransactionNotFound')) return 404;
  if (msg.includes('no ExecutionRecorded')) return 422;
  if (msg.includes('signer mismatch')) return 422;
  return 502;
}

async function anchorHandler(
  req: Request,
  res: Response,
  anchor: AnchorFn,
): Promise<void> {
  const body = AnchorBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'bad_body', detail: body.error.message });
    return;
  }
  const parsed = PayloadSchema.safeParse(body.data.payload);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_payload', detail: parsed.error.message });
    return;
  }

  const signature = body.data.signature as Hex;
  const hash = payloadHash(parsed.data);

  let signer: Hex;
  try {
    signer = await recoverMessageAddress({
      message: { raw: hash },
      signature,
    });
  } catch (err) {
    res.status(400).json({ error: 'bad_signature', detail: errMsg(err) });
    return;
  }
  if (signer.toLowerCase() === ZERO_ADDRESS) {
    res.status(400).json({ error: 'bad_signature', detail: 'recovered zero address' });
    return;
  }

  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    res.status(500).json({ error: 'misconfigured', detail: 'BASE_RPC_URL not set' });
    return;
  }

  let anchored: AnchorResult;
  try {
    anchored = await anchor({ payloadHash: hash, signature });
  } catch (err) {
    const { status, code } = anchorErrorResponse(err);
    res.status(status).json({ error: code, detail: errMsg(err) });
    return;
  }

  // base mainnet typically confirms in 2-4s; 90s + 1.5s polling absorbs
  // RPC node lag without throwing. on timeout we still return 200 so
  // @x402/express settles the buyer's payment: ExecutionLog.record() takes
  // a structurally validated signature as input and has no business-logic
  // branches that can revert after the tx leaves the mempool, so a pending
  // tx is guaranteed to confirm. throwing here makes the middleware skip
  // settle, gas is burned, and the buyer gets a free anchor — strictly
  // worse than charging on a near-certain pending tx.
  try {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash:            anchored.txHash,
        timeout:         90_000,
        pollingInterval: 1_500,
      });
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) {
        console.warn(`anchor confirm slow, tx=${anchored.txHash}; returning pending so settlement fires`);
        res.status(200).json({
          signer,
          payloadHash: hash,
          signature,
          txHash:    anchored.txHash,
          anchorUrl: `https://basescan.org/tx/${anchored.txHash}`,
          status:    'pending',
          message:   'Anchor submitted; confirmation is slow on the upstream RPC. Re-verify at /api/verify/<txHash>.',
        });
        return;
      }
      throw err;
    }
    if (receipt.status !== 'success') {
      res.status(502).json({ error: 'anchor_reverted', detail: `tx ${anchored.txHash}` });
      return;
    }
    res.status(200).json({
      signer,
      payloadHash: hash,
      signature,
      txHash:      anchored.txHash,
      blockNumber: receipt.blockNumber.toString(),
      anchorUrl:   `https://basescan.org/tx/${anchored.txHash}`,
    });
  } catch (err) {
    res.status(502).json({ error: 'anchor_confirm_failed', detail: errMsg(err) });
  }
}

function anchorErrorResponse(err: unknown): { status: number; code: string } {
  if (err instanceof RelayerTimeout)  return { status: 504, code: 'anchor_timeout'  };
  if (err instanceof RelayerReverted) return { status: 502, code: 'anchor_reverted' };
  return { status: 502, code: 'anchor_failed' };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
