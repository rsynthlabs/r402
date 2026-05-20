import express, { type Express } from 'express';

export function createServer(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // x402 paywall + impl land in W2.
  app.get('/api/verify/:txHash', (_req, res) => {
    res.status(501).json({ error: 'not_implemented', detail: 'W2 ships /api/verify' });
  });

  return app;
}
