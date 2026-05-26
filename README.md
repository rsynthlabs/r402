# r402

verifier-as-service on x402. paid http calls return the on-chain signer of
an execution proof — or anchor a signed payload to base mainnet without the
producer holding any eth.

paid. signed. proven.

- live: [https://r402.rsynth.ai](https://r402.rsynth.ai)
- repo: [github.com/rsynthlabs/r402](https://github.com/rsynthlabs/r402)
- latest anchor: [basescan.org/tx/0x0b272a46...](https://basescan.org/tx/0x0b272a46e8528bff832488b88a05bd377ecaae682a62291d17cf67d8b159cae7) (base block 46381639)

## 30-second demo

gate:

```
$ curl -i https://r402.rsynth.ai/api/verify/0x0b272a46e8528bff832488b88a05bd377ecaae682a62291d17cf67d8b159cae7
HTTP/2 402
payment-required: eyJ4NDAyVmVyc2lvbiI6Mi...   # base64(json)

{"error":"X-PAYMENT header is required"}
```

decoded `payment-required`:

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme":  "exact",
    "network": "eip155:8453",
    "asset":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount":  "1000000",
    "payTo":   "0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F",
    "extra":   { "name": "USD Coin", "version": "2" }
  }],
  "resource": { "url": "https://r402.rsynth.ai/api/verify/0x0b272a46..." }
}
```

pay (signed EIP-3009 `TransferWithAuthorization` in `payment-signature` header):

```
$ curl -H 'payment-signature: <base64 envelope>' \
       https://r402.rsynth.ai/api/verify/0x0b272a46e8528bff832488b88a05bd377ecaae682a62291d17cf67d8b159cae7
HTTP/2 200

{
  "signer":      "0x156d727f372D06132526612b7D34CE1693365bf3",
  "payloadHash": "0x4d2a1f...",
  "signature":   "0x...",
  "timestamp":   "1747250551",
  "blockNumber": "46381639",
  "txHash":      "0x0b272a46e8528bff832488b88a05bd377ecaae682a62291d17cf67d8b159cae7"
}
```

full roundtrip via `examples/buyer.ts` (anchor + verify, ~$2 USDC):

```
r402 buyer roundtrip — base mainnet

  buyer:   0x156d727f372D06132526612b7D34CE1693365bf3
  payload: agent_id=1, episode_id=buyer-roundtrip-1716480000000
  hash:    0x4d2a1f...

  POST https://r402.rsynth.ai/api/anchor (paying $1.00 USDC via x402)
    → anchored: 0x0b272a46e8528bff832488b88a05bd377ecaae682a62291d17cf67d8b159cae7
    → block:    46381639
    → basescan: https://basescan.org/tx/0x0b272a46e8528bff832488b88a05bd377ecaae682a62291d17cf67d8b159cae7

  GET  https://r402.rsynth.ai/api/verify/0x0b272a46...9cae7 (paying $1.00 USDC via x402)
    → signer: 0x156d727f372D06132526612b7D34CE1693365bf3 (match: ok)
    → hash:   0x4d2a1f... (match: ok)

  roundtrip complete. total: $2.00 USDC.
  paid. signed. proven.
```

## organic adoption

48h since public ship, zero marketing:

| metric | count |
|---|---|
| anchors on base mainnet | 8 |
| external signers | 3 |
| paid usdc revenue | ~$9 |
| signups, invites, drops | 0 |

receipts:

- payTo: [`0x132fA3...78F15F`](https://basescan.org/address/0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F)
- relayer: [`0x0d9242c7...4fd`](https://basescan.org/address/0x0d9242c7Da4a47E815023905e2a82B354fbCE4fd)
- ExecutionLog: [`0xd5A9DAF8...1a1c`](https://basescan.org/address/0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c)

three strangers paid $1 USDC each within 48h of public endpoint going live.
no founder ping, no airdrop, no waitlist. the endpoint speaks, somebody pays.

## integration

```
pnpm install
export BUYER_PRIVATE_KEY=0x...
npx tsx --env-file=.env examples/buyer.ts
```

the full buyer flow lives in [`examples/buyer.ts`](./examples/buyer.ts). x402 v2
EIP-3009 typed-data signing is hand-rolled there until `x402-fetch` ships a
v2-compatible client; the public package still negotiates v1 against bare
network names and body-encoded requirements.

## sub-agent budgets

a main agent grants a sub-agent a $5.00 USDC spending cap via ERC-7710.
the sub-agent burns through it in five $1.00 x402 calls. the sixth call's
on-chain `DelegationManager.redeemDelegations(...)` reverts at the
`ERC20TransferAmountEnforcer` — no balance check, no application logic,
the chain refuses.

```
r402 sub-agent budget — base mainnet

  main:    0x<...>  (smart account, MetaMask Hybrid)
  sub:     0x<...>  (EOA, derived from main)
  cap:     5.00 USDC

  delegation granted (erc20TransferAmount, max 5.00 USDC)
    → manager:  0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
    → caveat:   ERC20TransferAmountEnforcer @ 0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc
    → digest:   0x<...>

  → call 1/5 (paying $1.00 USDC via x402 → 0x132fA38...)
       redeem: 0x<...>
       verify: 0x156d72... (anchored signer)
  → call 2/5 ...
  → call 5/5 ...

  → call 6/5 (attempting beyond cap)
       redeem: reverted at caveat enforcer (ERC20TransferAmountEnforcer)

  budget exhausted. 5/5 used. ok.
```

total: ~$5.00 USDC + ~$2-3 base mainnet gas. full impl at
[`examples/sub-agent-budget.ts`](./examples/sub-agent-budget.ts). main
agent is a MetaMask Hybrid smart account; sub-agent is an EOA derived
deterministically from `MAIN_PRIVATE_KEY` so gas is funded once and the
demo is replayable. `@metamask/smart-accounts-kit` v1.5+,
`DelegationManager` v1.3.0 on base mainnet.

## architecture

- seller paywall: `@x402/express` `paymentMiddleware` on `/api/verify/:txHash` and `/api/anchor`, base mainnet USDC
- settlement: [OpenX402](https://facilitator.openx402.ai) facilitator — permissionless, no-KYC, mainnet
- relayer: self-hosted hot wallet via viem `walletClient` — pays gas only, never holds agent keys (`ECDSA.recover` extracts the producer's signer from the signature; `tx.origin` is irrelevant to attribution)
- on-chain anchor: [`ExecutionLog`](https://basescan.org/address/0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c) at `0xd5A9DAF8F2134b61b73cEfaF5c9094EA162f1a1c`
- cross-language verify primitive: shared canonical encoder in python ([`sdk`](https://github.com/rsynthlabs/sdk)) and typescript ([`src/canonical.ts`](./src/canonical.ts)), byte-for-byte. sign once, verify anywhere.

## what's verified

a payload conforms to schema v0.1.0 → canonical_bytes (sorted keys, no
whitespace, utf-8, `.0`-pinned floats) → `keccak256` → EIP-191 `personal_sign`
→ `ExecutionLog.record(payloadHash, signature)` emits `ExecutionRecorded`.
verification reads the event back from base mainnet, decodes the original
`signature` from calldata, and runs `recoverMessageAddress` against the
recorded `payloadHash`. recovered address must equal the indexed `signer` or
the endpoint returns 422.

the canonical primitive is runtime-agnostic by construction: a signature
produced by python (`eth_account.messages.encode_defunct`) recovers to the
same address inside solidity (`OZ MessageHashUtils.toEthSignedMessageHash` +
`ECDSA.recover`) and inside this typescript verifier (viem
`recoverMessageAddress`). all three byte-equivalent, asserted by
`tests/verify.crosslang.test.ts`.

## run locally

```
pnpm install
cp .env.example .env   # fill BASE_RPC_URL, RELAYER_PRIVATE_KEY
pnpm dev
```

health: `curl https://r402.rsynth.ai/health`. env vars documented in
[`.env.example`](./.env.example).

## cook-off

submitted to the MetaMask × 1Shot × Venice AI dev cook-off:

- **track 1 — best x402 + ERC-7710 ($3K)** — primary. live base-mainnet roundtrip, USDC settlement, self-hosted permissionless relayer, sub-agent budget via ERC-7710 delegation (W4).
- **track 2 — 1Shot permissionless relayer** — pivoted. 1Shot's free plan blocked smart-account creation, so the gas-relay role is filled by `src/relayer.ts` (self-hosted viem `walletClient`). same on-chain attribution semantics; `ECDSA.recover` recovers the producer signer regardless of `tx.origin`.
- **track 4 — best social media (#MetaMaskDev)** — weekly build-in-public posts.

## license

MIT. see [LICENSE](./LICENSE).
