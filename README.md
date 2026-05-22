# r402

verifier-as-service for `$R` execution proofs. pay a few cents in USDC over x402, get back the on-chain signer of a robot execution anchored on base.

- v0.1 — W1 scaffolding shipped
- license: MIT
- verifies records emitted by [ExecutionLog](https://basescan.org/address/0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c) on base mainnet

## why

buyers of robot execution data need a one-line check before paying. r402 wraps the [rsynth](https://github.com/rsynthlabs/sdk) verify flow behind an http endpoint and meters access with x402 — no custom signing, no rpc credentials, just a tx hash.

## architecture

```
buyer agent (MM smart account + ERC-7710 delegation)
  │  GET /api/verify/:txHash
  ▼
x402 paymentMiddleware (USDC, MM facilitator)
  ▼
r402:
  → read ExecutionRecorded(signer, payloadHash) on base
  → fetch off-chain payload (agent-provided URL)
  → keccak256(canonical_bytes(payload)) == payloadHash
  → recover EIP-191 signer, == on-chain signer
  ▼
{ verified, agent_id, payload_hash, signer, block, tx_hash }
```

## roadmap

- **W1** (this commit) — scaffold, `/health`, `canonical.ts` byte-equivalent with [sdk](https://github.com/rsynthlabs/sdk)
- **W2** — `/api/verify/:txHash`, x402 `paymentMiddleware` on `@x402/express`, MM facilitator
- **W3** — buyer-side demo with `@metamask/smart-accounts-kit` and ERC-7710 sub-agent budget
- **W4** — public deploy, demo video, submission

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

| var            | required | notes                                       |
|----------------|----------|---------------------------------------------|
| `BASE_RPC_URL` | yes      | base MAINNET rpc (chain 8453). not sepolia. |

public url: `https://r402.rsynth.ai`.

## buyer flow

```
# gate
$ curl -i https://r402.rsynth.ai/api/verify/0xabc...
HTTP/2 402
content-type: application/json

{ "x402Version": 1, "accepts": [...], "error": "X-PAYMENT header is required" }

# pay
$ curl -i -H "X-PAYMENT: <signed-permit>" https://r402.rsynth.ai/api/verify/0xabc...
HTTP/2 200

{
  "verified": true,
  "agent_id": "10311",
  "payload_hash": "0xf4956c...",
  "signer": "0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe",
  "anchor_tx": "0x713cf78...",
  "block": 46166628
}
```

`@x402/client` is the canonical buyer.

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
