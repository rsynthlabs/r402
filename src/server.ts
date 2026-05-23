import express, { type Express, type Request, type Response } from 'express';
import { paymentMiddleware } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { z } from 'zod';
import {
  createPublicClient,
  http,
  recoverMessageAddress,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { verifyAnchor } from './verify.js';
import { payloadHash } from './canonical.js';
import { PayloadSchema } from './schema.js';
import {
  anchorViaOneShot,
  OneShotTimeout,
  type AnchorParams,
  type AnchorResult,
} from './relayer.js';

// Facilitator: x402.org canonical default (Sepolia testnet) — verified schema-compliant against @x402/core v2.12.0.
//
// Why Sepolia for v0.1:
// - Public Base mainnet x402 in 2026-Q2 = either Coinbase CDP (credential-dependency, KYT/OFAC) or self-hosted.
// - Probed third-party "Base mainnet" facilitators 2026-05-21:
//     AutoIncentive — DNS failure (infra dead)
//     0xArchive     — domain parked on GoDaddy (infra dead)
//     fretchen.eu   — 200 OK but /supported.extensions schema drift, fails @x402/core v2.12.0 zod parse
// - Sepolia + canonical facilitator = schema-guaranteed, free, zero credential surface, full x402 flow.
//
// MAINNET UPGRADE PATH (W4 or post-Cook-Off):
//   1. NETWORK → 'eip155:8453'
//   2. FACILITATOR_URL → @coinbase/x402 authenticated facilitator with CDP creds, OR self-hosted facilitator
//   3. Add CDP_API_KEY_ID + CDP_API_KEY_SECRET env (CDP path) OR deploy self-host (self-host path)
//   4. No other code change — verify.ts already targets mainnet, this only flips payment rail.
const PAY_TO          = '0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F';
const PRICE           = '$1.00';
const NETWORK         = 'eip155:84532';
const FACILITATOR_URL = 'https://x402.org/facilitator';

// duplicated from verify.ts (locked); keep in sync if ExecutionLog redeploys.
const EXECUTION_LOG_ADDRESS = '0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c';

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
  const anchor: AnchorFn = opts.anchor ?? anchorViaOneShot;

  const app = express();
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
  const resourceServer = new x402ResourceServer(facilitator).register(
    NETWORK,
    new ExactEvmScheme(),
  );

  app.use(
    paymentMiddleware(
      {
        'GET /api/verify/:txHash': {
          accepts: {
            scheme: 'exact',
            price: PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
          description: 'verify a $R execution proof anchored on Base',
        },
        'POST /api/anchor': {
          accepts: {
            scheme: 'exact',
            price: PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
          description: 'anchor a signed $R execution proof to Base via 1Shot',
        },
      },
      resourceServer,
    ),
  );

  app.get('/api/verify/:txHash', verifyHandler);
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
    const status = mapAnchorError(err);
    res.status(status).json({
      error: status === 504 ? 'anchor_timeout' : 'anchor_failed',
      detail: errMsg(err),
    });
    return;
  }

  try {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const receipt = await client.getTransactionReceipt({ hash: anchored.txHash });
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

function mapAnchorError(err: unknown): number {
  if (err instanceof OneShotTimeout) return 504;
  return 502;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
