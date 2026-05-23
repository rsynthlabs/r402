# r402 buyer roundtrip

end-to-end demo against the live `https://r402.rsynth.ai` deployment on base mainnet. pays real USDC through the x402 paywall, anchors a signed payload via the r402 relayer, and reads back the proof through `/api/verify`.

## what it does

1. builds a v0.1.0 execution payload conforming to [`src/schema.ts`](../src/schema.ts).
2. hashes it with the shared canonical encoder ([`src/canonical.ts`](../src/canonical.ts)).
3. signs the hash with EIP-191 using the buyer's local wallet.
4. `POST /api/anchor { payload, signature }` — pays $1.00 USDC via x402, server signs `ExecutionLog.record()` from its relayer wallet, returns `{ signer, payloadHash, signature, txHash, blockNumber, anchorUrl }`.
5. `GET  /api/verify/:txHash` — pays $1.00 USDC via x402, server reads the `ExecutionRecorded` event back from base mainnet, returns the same signer + hash.
6. asserts the round-tripped `signer` equals the buyer address and the round-tripped `payloadHash` equals the local hash.

## setup

create a `.env` at the repo root (already gitignored):

```
BUYER_PRIVATE_KEY=0x<64 hex chars>
R402_BASE_URL=https://r402.rsynth.ai   # optional, this is the default
```

fund the buyer wallet on base mainnet:

- ≥ 2 USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- a few thousand gwei of ETH for the EIP-3009 signature gas amortization (the facilitator submits, you don't pay gas directly — minimal ETH is just safety)

bridge via [bridge.base.org](https://bridge.base.org) or fund via any base-mainnet exchange.

## run

```
npx tsx --env-file=.env examples/buyer.ts
```

duration: typically 5–15 seconds (anchor mining + verify roundtrip). hard cap ~30s.

## expected output

```
r402 buyer roundtrip — base mainnet

  buyer:   0x156d727f372D06132526612b7D34CE1693365bf3
  payload: agent_id=1, episode_id=buyer-roundtrip-1716480000000
  hash:    0x4d2a1f...

  POST https://r402.rsynth.ai/api/anchor (paying $1.00 USDC via x402)
    → anchored: 0x713cf78...
    → block:    18234567
    → basescan: https://basescan.org/tx/0x713cf78...

  GET  https://r402.rsynth.ai/api/verify/0x713cf78...5bf3 (paying $1.00 USDC via x402)
    → signer: 0x156d727f372D06132526612b7D34CE1693365bf3 (match: ok)
    → hash:   0x4d2a1f... (match: ok)

  roundtrip complete. total: $2.00 USDC.
  paid. signed. proven.
```

## cost breakdown

| step              | who you pay                     | amount        |
|-------------------|---------------------------------|---------------|
| `POST /api/anchor`| r402 (PAY_TO), via OpenX402     | $1.00 USDC    |
| `GET  /api/verify`| r402 (PAY_TO), via OpenX402     | $1.00 USDC    |
| record() gas      | base mainnet                    | r402 absorbs  |

total: **$2.00 USDC** per roundtrip. r402's relayer wallet pays the on-chain gas for `ExecutionLog.record()` out of the anchor fee margin.

## exit codes

| code | meaning                                                              |
|------|----------------------------------------------------------------------|
|  0   | full roundtrip success                                               |
|  1   | x402 payment proof rejected (env missing, malformed, or facilitator) |
|  2   | `/api/anchor` returned non-200 after payment                         |
|  3   | verified signer or payloadHash didn't match local                    |
| 99   | unexpected error (network, RPC, etc.)                                |

## protocol notes

r402 runs x402 protocol version 2 (`@x402/core` v2.x stack):

- payment requirements arrive in the `payment-required` HTTP header (base64-encoded JSON), not the response body.
- network identifiers are CAIP-2 strings (`eip155:8453`), not bare names.
- the `X-PAYMENT` header sends a base64 envelope `{ x402Version, accepted, payload: { signature, authorization } }` where `authorization` is the EIP-3009 `TransferWithAuthorization` fields.

`buyer.ts` implements this manually with `viem.signTypedData` because the public `x402-fetch` package still speaks the v1 protocol (legacy `network: "base"`, body-encoded requirements) and won't negotiate against v2 servers. when a v2-compatible client SDK ships, the manual block can be swapped for a few lines.
