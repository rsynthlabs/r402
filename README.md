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

## health

```
curl http://localhost:3000/health
# { "status": "ok" }
```

## license

MIT. see [LICENSE](./LICENSE).

---

robotics starts with $R.
