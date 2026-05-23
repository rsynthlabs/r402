import type { Hex } from 'viem';

// 1Shot exposes a per-method URL (POST → execution_id) plus a polling endpoint
// (GET /v1/executions/<id> → status, transaction_hash). r402 does not trust
// 1Shot's reported status alone — the anchor handler re-confirms the receipt
// via Base RPC, so the only contract this module owns is "return the tx hash
// 1Shot submitted, or throw". keep parse points narrow; a wire-shape drift
// should surface as OneShotError with the missing field named.

export interface AnchorParams {
  payloadHash: Hex;
  signature: Hex;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AnchorResult {
  txHash: Hex;
}

export class OneShotError   extends Error { constructor(m: string) { super(m); this.name = 'OneShotError';   } }
export class OneShotFailed  extends Error { constructor(m: string) { super(m); this.name = 'OneShotFailed';  } }
export class OneShotTimeout extends Error { constructor(m: string) { super(m); this.name = 'OneShotTimeout'; } }

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export async function anchorViaOneShot(p: AnchorParams): Promise<AnchorResult> {
  const apiKey    = process.env.ONESHOT_API_KEY;
  const methodUrl = process.env.ONESHOT_METHOD_URL;
  if (!apiKey)    throw new OneShotError('ONESHOT_API_KEY not set');
  if (!methodUrl) throw new OneShotError('ONESHOT_METHOD_URL not set');

  const envTimeout     = process.env.ONESHOT_TIMEOUT_MS ? Number(process.env.ONESHOT_TIMEOUT_MS) : undefined;
  const timeoutMs      = p.timeoutMs      ?? envTimeout ?? 30_000;
  const pollIntervalMs = p.pollIntervalMs ?? 2_000;

  const startRes = await fetch(methodUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      params: { payloadHash: p.payloadHash, signature: p.signature },
    }),
  });
  if (!startRes.ok) {
    throw new OneShotError(`1shot POST ${startRes.status} ${startRes.statusText}`);
  }
  const startBody = await safeJson(startRes);
  const executionId = pickString(startBody, ['execution_id', 'id']);
  if (!executionId) {
    throw new OneShotError('1shot POST: missing execution_id');
  }

  const pollUrl  = new URL(`/v1/executions/${executionId}`, methodUrl).toString();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const r = await fetch(pollUrl, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      throw new OneShotError(`1shot GET ${r.status} ${r.statusText}`);
    }
    const body   = await safeJson(r);
    const status = pickString(body, ['status']);
    const tx     = pickString(body, ['transaction_hash', 'tx_hash']);

    if (status === 'failed' || status === 'reverted') {
      throw new OneShotFailed(`1shot execution ${executionId} ${status}`);
    }
    if (status === 'confirmed' && tx && TX_HASH_RE.test(tx)) {
      return { txHash: tx as Hex };
    }
  }

  throw new OneShotTimeout(`1shot anchor exceeded ${timeoutMs}ms`);
}

async function safeJson(r: Response): Promise<unknown> {
  try { return await r.json(); } catch { return null; }
}

function pickString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
