import express, { type Express, type Request, type Response } from 'express';
import { paymentMiddleware } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { z } from 'zod';
import { verifyAnchor } from './verify.js';

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

export function createServer(): Express {
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
      },
      resourceServer,
    ),
  );

  app.get('/api/verify/:txHash', verifyHandler);

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
