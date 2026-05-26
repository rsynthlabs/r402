# r402 examples

two demos against the live `https://r402.rsynth.ai` deployment on base mainnet:

- [`buyer.ts`](#r402-buyer-roundtrip) — single-EOA roundtrip, ~$2 USDC
- [`sub-agent-budget.ts`](#sub-agent-budget) — ERC-7710 sub-agent with on-chain spending cap, ~$5 USDC + ~$2-3 gas

---

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

---

# sub-agent budget

end-to-end ERC-7710 demo against the live `https://r402.rsynth.ai` deployment on base mainnet. a main agent grants a sub-agent a $5.00 USDC spending cap via the MetaMask delegation framework; the sub-agent burns through it in five $1.00 x402 calls; the sixth call's on-chain redeem reverts at the caveat enforcer. real USDC, real revert, no mocks.

## what it does

1. derives the sub-agent EOA deterministically from `MAIN_PRIVATE_KEY` (`keccak256(main_pk || 'r402-sub-agent-v1')`).
2. constructs a main MetaMask Hybrid smart account with the main EOA as owner.
3. preflight: deploys the main smart account if needed (one-off `SimpleFactory.deploy()` from the main EOA, ~0.001 ETH gas), checks USDC and ETH balances, fails with a funding template if either is short.
4. signs an ERC-7710 delegation off-chain: scope = `erc20TransferAmount`, token = base mainnet USDC, max = 5.00 USDC.
5. loops 5 times:
   - sub-agent calls `DelegationManager.redeemDelegations(...)` to pull $1.00 USDC main → sub.
   - sub-agent pays r402 $1.00 via x402 EIP-3009 (`GET /api/verify/<txHash>`).
6. 6th iteration: same `redeemDelegations` call must revert at the `ERC20TransferAmountEnforcer` (cumulative cap exceeded). caught, surfaced as `budget exhausted. 5/5 used. ok.`, exits 1.

## setup

create a `.env` at the repo root (already gitignored):

```
MAIN_PRIVATE_KEY=0x<64 hex chars>
BASE_RPC_URL=https://...
```

run once with empty wallets — the demo prints exact funding instructions for the predicted main-smart-account address and the derived sub-agent address. then fund:

- ≥ 5.10 USDC at the main smart account (USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- ≥ 0.0005 ETH at the sub-agent EOA (covers 6 redeem txs at base mainnet gas)
- ≥ 0.001 ETH at the main EOA (covers the one-time smart-account deploy; skip if main is already deployed)

sub-agent address is deterministic, so funding it once survives across re-runs.

## run

```
npx tsx --env-file=.env examples/sub-agent-budget.ts
```

duration: typically 60-120 seconds (10 on-chain txs: optional deploy + 6 redeems + 5 x402 facilitator settlements).

## expected output

```
r402 sub-agent budget — base mainnet

  main:    0x<...>  (smart account, MetaMask Hybrid)
  sub:     0xE19b2A...3Dfb  (EOA, derived from main)
  cap:     5.00 USDC

  delegation granted (erc20TransferAmount, max 5.00 USDC)
    → manager:  0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
    → caveat:   ERC20TransferAmountEnforcer @ 0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc
    → digest:   0x<...>

  → call 1/5 (paying $1.00 USDC via x402 → 0x132fA38...)
       redeem: 0x<...>
       signer: 0xE19b2A...3Dfb (match: ok)
  → call 2/5 ...
  → call 5/5 ...

  → call 6/5 (attempting beyond cap)
       redeem: reverted at caveat enforcer (ERC20TransferAmountEnforcer)

  budget exhausted. 5/5 used. ok.
```

## cost breakdown

| step                                     | who you pay                  | amount          |
|------------------------------------------|------------------------------|-----------------|
| one-time main smart account deploy       | base mainnet gas             | ~0.001 ETH      |
| 6 × `DelegationManager.redeemDelegations`| base mainnet gas (from sub)  | ~0.0005 ETH     |
| 5 × x402 `/api/verify` payment           | r402 (PAY_TO), via OpenX402  | $5.00 USDC      |
| 5 × x402 facilitator settlement gas      | settled by facilitator       | absorbed in fee |

total: **~$5.00 USDC + ~0.0015 ETH** gas, mainnet. main smart-account deploy is one-off; subsequent demo runs only need the redeem + settle gas.

## exit codes

| code | meaning                                                                          |
|------|----------------------------------------------------------------------------------|
|  1   | expected — budget exhausted at the caveat enforcer, OR preflight failure (funding/env) |
|  2   | unexpected — 6th redeem succeeded; cap was not enforced (smoke-test regression)  |
|  3   | x402 verify signer mismatch (sub-agent address didn't recover)                   |
|  4   | 6th redeem reverted but not at the expected enforcer (toolkit/contract drift)    |
| 99   | unexpected error (network, RPC, etc.)                                            |

## why this matters

ERC-7710 lets a main agent grant a sub-agent narrowly-scoped, revocable, on-chain-enforced authority. for r402 the cap is denominated in the same USDC that pays the x402 paywall — so an agent can hand a budget to a sub-task and the chain itself refuses to let it overrun. no off-chain accounting, no allowance race, no "agent stole my keys" failure mode. the sixth call doesn't 402 because the buyer ran out of money; it doesn't even reach the seller. the `ERC20TransferAmountEnforcer` returns first.

## architecture notes

- main is a MetaMask Hybrid smart account; sub-agent is a plain EOA. delegate addresses in the toolkit are just `Hex` — the smart-account-vs-EOA split lives entirely on the delegator side.
- direct `SimpleFactory.deploy()` from the main EOA is used for one-time smart-account deployment so the demo has no bundler dependency. `mainSmart.getFactoryArgs()` provides the factory address and calldata; if the smart account is already deployed, both fields are `undefined` and the deploy is skipped.
- caveat-enforcer reverts come wrapped (manager → enforcer); `viem.BaseError.walk()` extracts the `ContractFunctionRevertedError` so we can match on the `ERC20TransferAmountEnforcer:...` substring without depending on a specific toolkit revert phrasing.
- the x402 EIP-3009 leg is byte-identical to [`buyer.ts`](./buyer.ts) and intentionally duplicated to keep that file untouched.
