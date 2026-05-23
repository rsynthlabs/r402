# r402

verifier + permissionless relayer for `$R` execution proofs. pay a few cents in USDC over x402, get back the on-chain signer of a robot execution — or anchor a signed payload yourself without holding any ETH.

- v0.1 — W3 verifier + relayer shipped
- license: MIT
- reads + writes [ExecutionLog](https://basescan.org/address/0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c) on base mainnet

## why

two sides of the same proof:

- **buyers** need a one-line check before paying for an execution. `GET /api/verify/:txHash` returns the canonical signer + payload hash.
- **producers** need to anchor a signed payload to base mainnet without holding ETH. `POST /api/anchor` forwards `{payload, signature}` to an r402-hosted relayer wallet that calls `ExecutionLog.record()` on the producer's behalf. on-chain `ECDSA.recover` extracts the producer's signer from the signature payload, so `tx.origin` (this wallet) is irrelevant to attribution.

both endpoints are gated by x402 (USDC, base mainnet, $1.00) via [OpenX402](https://facilitator.openx402.ai). the agent pays nothing in gas. r402 stays stateless — no payload storage, no key custody.

we use OpenX402 as our facilitator — permissionless, free, no KYC, listed on [x402scan](https://www.x402scan.com). this makes r402 a pure production demo with real USDC settlement on base mainnet, not testnet.

## architecture

```
verify path:
  buyer ──GET /api/verify/:txHash──▶ r402 ──▶ base mainnet (ExecutionLog log)
                                      │
                                      └──▶ { signer, payloadHash, signature,
                                             txHash, blockNumber }

anchor path:
  producer ──POST /api/anchor──▶ r402 ──▶ relayer wallet ──▶ ExecutionLog.record()
            { payload, signature }   │                        on base mainnet
                                     ├──▶ canonicalize + EIP-191 recover
                                     └──▶ base RPC: confirm tx receipt
                                                                 │
                                                                 ▼
                                  { signer, payloadHash, signature,
                                    txHash, blockNumber, anchorUrl }
```

single plane, single chain — base mainnet (chain 8453) end to end:
  - x402 settlement: USDC on base mainnet, via OpenX402 facilitator
  - ExecutionLog anchor: base mainnet, via self-hosted relayer wallet
both planes use the same `BASE_RPC_URL`. PRICE is pinned to USDC on base mainnet (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, atomic units: `1_000_000` = $1.00) so a facilitator swap can't silently re-asset the route.

## roadmap

- **W1** — scaffold, `/health`, `canonical.ts` byte-equivalent with [sdk](https://github.com/rsynthlabs/sdk)
- **W2** — `/api/verify/:txHash`, x402 `paymentMiddleware` on `@x402/express`
- **W3** — vercel serverless deploy, `POST /api/anchor` via self-hosted hot-wallet relayer (viem `writeContract`)
- **W3.5** (this commit) — base mainnet paywall via OpenX402 facilitator; testnet plane retired
- **W4** — buyer-side demo with `@metamask/smart-accounts-kit` and ERC-7710 sub-agent budget, submission

## relation to sdk

- [`sdk`](https://github.com/rsynthlabs/sdk) defines the payload schema, `canonical_bytes`, EIP-191 signing, and the on-chain `ExecutionLog` contract.
- r402 ports `canonical_bytes` to typescript byte-for-byte (`src/canonical.ts`), validated against `sdk/sdk/tests/test_payload.py::SCHEMA_EXAMPLE_HASH`.
- the canonical schema mirrors `sdk/SCHEMA.md` v0.1.0 (sha1 `471308f9`). a drift test fails if the upstream changes.

## install

```
pnpm install
```

## scripts

```
pnpm dev        # tsx watch
pnpm build      # tsc -> dist/
pnpm start      # node dist/index.js
pnpm test       # vitest run
pnpm typecheck  # tsc --noEmit
```

## deploy

vercel serverless. node 20 runtime. one function: `api/index.ts` re-exports the express app.

```
pnpm install
vercel --prod
```

env vars (set in vercel project settings):

| var                   | required          | notes                                                                  |
|-----------------------|-------------------|------------------------------------------------------------------------|
| `BASE_RPC_URL`        | yes               | base MAINNET rpc (chain 8453). single chain end-to-end, no sepolia.    |
| `RELAYER_PRIVATE_KEY` | for `/api/anchor` | hot wallet that signs `ExecutionLog.record()` txs. fund with base ETH. |
| `RELAYER_TIMEOUT_MS`  | no                | per-request `writeContract` deadline. default 30000.                   |
| `FACILITATOR_URL`     | no                | x402 facilitator override. default OpenX402.                           |

public url: `https://r402.rsynth.ai`.

### relayer setup (one-time, before `/api/anchor` works)

1. generate a hot wallet: `cast wallet new --json` (or any 32-byte hex private key).
2. fund the wallet with ~0.002 ETH on base mainnet (~60 anchors at current gas).
3. set `RELAYER_PRIVATE_KEY` in vercel env. redeploy.

the wallet only spends gas — on-chain `ECDSA.recover` extracts the producer's signer from the signature payload, so this wallet has no claim over recorded executions.

## verify flow (buyer)

```
# gate
$ curl -i https://r402.rsynth.ai/api/verify/0xabc...
HTTP/2 402

{ "x402Version": 1, "accepts": [...], "error": "X-PAYMENT header is required" }

# pay
$ curl -i -H "X-PAYMENT: <signed-permit>" https://r402.rsynth.ai/api/verify/0xabc...
HTTP/2 200

{
  "signer":      "0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe",
  "payloadHash": "0x26444c4ba73c1f692533ddcf1827e56f5cefe27cbbd169c87ff11c443e99aa8d",
  "signature":   "0x...",
  "timestamp":   "1747250551",
  "blockNumber": "46166628",
  "txHash":      "0x713cf78..."
}
```

## anchor flow (producer)

agent pays $1.00 in USDC over x402. agent pays nothing in ETH. r402's relayer wallet calls `ExecutionLog.record(payloadHash, signature)` on base mainnet, then re-confirms the receipt before returning.

```
$ curl -i -X POST -H "X-PAYMENT: <signed-permit>" \
       -H "content-type: application/json" \
       -d '{"payload": {<v0.1.0 payload>}, "signature": "0x..."}' \
       https://r402.rsynth.ai/api/anchor
HTTP/2 200

{
  "signer":      "0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe",
  "payloadHash": "0x26444c4b...",
  "signature":   "0x...",
  "txHash":      "0x713cf78...",
  "blockNumber": "46166628",
  "anchorUrl":   "https://basescan.org/tx/0x713cf78..."
}
```

errors: `400 bad_body | bad_payload | bad_signature`, `402` paywall, `502 anchor_failed | anchor_reverted`, `504 anchor_timeout`.

## try it

`examples/buyer.ts` is a runnable end-to-end roundtrip against the live deployment: pays real USDC on base mainnet, anchors a signed payload, verifies it back. ~$2 USDC total per run.

```
npx tsx --env-file=.env examples/buyer.ts
```

see [`examples/README.md`](./examples/README.md) for env setup, funding, expected output, and exit codes.

## health

```
curl https://r402.rsynth.ai/health
# { "ok": true, "contract": "0xd5A9...", "chain": "base", "commit": "<sha7>" }
```

sanity-check after a deploy without burning usdc. `commit` is the 7-char `VERCEL_GIT_COMMIT_SHA` or `"dev"` locally.

## license

MIT. see [LICENSE](./LICENSE).

---

robotics starts with $R.
