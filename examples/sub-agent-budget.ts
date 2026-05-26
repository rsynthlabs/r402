// erc-7710 sub-agent budget demo against live r402 (base mainnet).
//
// main agent (MetaMask Hybrid smart account) grants a sub-agent EOA a
// $5.00 USDC spending cap via ERC-7710 delegation. the sub-agent burns
// through it in five $1.00 /api/verify calls. the sixth call's
// DelegationManager.redeemDelegations(...) reverts at the
// ERC20TransferAmountEnforcer — caveat-enforced, not balance-enforced.
//
// each iteration is two on-chain ops: (1) sub redeems $1 from main via
// the DelegationManager → sub's EOA, (2) sub pays r402 $1 via x402
// EIP-3009 (same flow as examples/buyer.ts). budget = on-chain caveat,
// not wallet balance.
//
// total cost: ~$5.00 USDC + ~$2-3 ETH gas on base mainnet.
//
// run: npx tsx --env-file=.env examples/sub-agent-budget.ts

import crypto from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toHex,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  Implementation,
  ScopeType,
  createDelegation,
  hashDelegation,
  toMetaMaskSmartAccount,
} from '@metamask/smart-accounts-kit';
import { encodeDelegations } from '@metamask/smart-accounts-kit';
import { createExecution, ExecutionMode, encodeSingleExecution } from '@metamask/smart-accounts-kit';
import { contracts } from '@metamask/smart-accounts-kit';
const DelegationManagerAbi = contracts.DelegationManager;

const CHAIN_ID = 8453;
const USDC_BASE      = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const PAY_TO         = '0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F' as const;
const KNOWN_TX       = '0x0b272a46e8528bff832488b88a05bd377ecaae682a62291d17cf67d8b159cae7' as const;
const SUB_KEY_TAG    = 'r402-sub-agent-v1';
const CAP_USDC       = parseUnits('5', 6);   // 5_000_000
const PER_CALL_USDC  = parseUnits('1', 6);   // 1_000_000
const PREFLIGHT_USDC = parseUnits('5.10', 6); // 5.10 USDC: 5 calls + slop
const MIN_SUB_ETH    = parseEther('0.0005');  // ~6 redeem txs at base gas
const MIN_MAIN_ETH   = parseEther('0.001');   // one-time deploy gas
// match buyer.ts (server pins these in src/server.ts USDC_EIP712)
const USDC_DOMAIN_NAME    = 'USD Coin';
const USDC_DOMAIN_VERSION = '2';

const C = {
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface VerifyResponse {
  signer:      Hex;
  payloadHash: Hex;
  signature:   Hex;
  timestamp:   string;
  blockNumber: string;
  txHash:      Hex;
}

interface PaymentRequirements {
  scheme:            string;
  network:           string;
  asset:             Hex;
  amount:            string;
  payTo:             Hex;
  maxTimeoutSeconds: number;
  extra:             Record<string, unknown>;
}

interface PaymentRequired {
  x402Version: number;
  accepts:     PaymentRequirements[];
  resource?:   unknown;
  error?:      string;
}

interface ExactAuthorization {
  from:        Hex;
  to:          Hex;
  value:       string;
  validAfter:  string;
  validBefore: string;
  nonce:       Hex;
}

class HttpError    extends Error { constructor(public status: number, public body: string) { super(`HTTP ${status}: ${body.slice(0, 200)}`); } }
class X402Rejected extends Error { constructor(public required: PaymentRequired | null) { super('payment proof rejected after retry'); } }

function short(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 10)}...${hex.slice(-4)}` : hex;
}

// deterministic sub-agent key. same input → same address every run, so
// the user funds gas once. tag rotates if the derivation scheme changes.
export function deriveSubAgentKey(mainPk: Hex, tag: string = SUB_KEY_TAG): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(mainPk)) throw new Error('invalid main private key');
  return keccak256(toHex(mainPk + tag));
}

function decodeRequired(headerB64: string | null): PaymentRequired | null {
  if (!headerB64) return null;
  try { return JSON.parse(Buffer.from(headerB64, 'base64').toString('utf-8')) as PaymentRequired; }
  catch { return null; }
}

async function signAuthorization(
  account: LocalAccount,
  req: PaymentRequirements,
): Promise<{ sig: Hex; authorization: ExactAuthorization }> {
  const validAfter  = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds);
  const nonce       = ('0x' + crypto.randomBytes(32).toString('hex')) as Hex;
  const value       = BigInt(req.amount);

  const sig = await account.signTypedData({
    domain: {
      name:              USDC_DOMAIN_NAME,
      version:           USDC_DOMAIN_VERSION,
      chainId:           CHAIN_ID,
      verifyingContract: req.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: { from: account.address, to: req.payTo, value, validAfter, validBefore, nonce },
  });

  return {
    sig,
    authorization: {
      from:        account.address,
      to:          req.payTo,
      value:       value.toString(),
      validAfter:  validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };
}

// x402 EIP-3009 call. mirrors examples/buyer.ts:175 — duplicated here to
// honor the "don't touch buyer.ts" constraint. when an x402 v2 client SDK
// ships, both files collapse to a few lines.
async function callWithX402<T>(
  url: string,
  method: 'GET' | 'POST',
  body: unknown,
  account: LocalAccount,
): Promise<T> {
  const baseHeaders: Record<string, string> = body !== undefined ? { 'content-type': 'application/json' } : {};
  const baseInit: RequestInit = {
    method,
    headers: baseHeaders,
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  };

  const first = await fetch(url, baseInit);
  if (first.status !== 402) {
    if (!first.ok) throw new HttpError(first.status, await first.text());
    return (await first.json()) as T;
  }

  const required = decodeRequired(first.headers.get('payment-required'));
  const accept   = required?.accepts?.[0];
  if (!accept) throw new Error('402 without decodable payment-required accepts[]');
  if (accept.scheme !== 'exact') throw new Error(`unsupported scheme: ${accept.scheme}`);

  const { sig, authorization } = await signAuthorization(account, accept);
  const envelope = {
    x402Version: required!.x402Version,
    accepted:    accept,
    payload:     { signature: sig, authorization },
  };
  const xPayment = Buffer.from(JSON.stringify(envelope), 'utf-8').toString('base64');

  const retry = await fetch(url, { ...baseInit, headers: { ...baseHeaders, 'payment-signature': xPayment } });
  if (retry.status === 402) throw new X402Rejected(decodeRequired(retry.headers.get('payment-required')));
  if (!retry.ok) throw new HttpError(retry.status, await retry.text());
  return (await retry.json()) as T;
}

// caveat-enforcer revert is wrapped twice (manager → enforcer). viem's
// .walk() finds the innermost ContractFunctionRevertedError. its data is
// typically a Solidity string-revert like "ERC20TransferAmountEnforcer:
// allowance-exceeded". this matcher is intentionally loose — the enforcer
// name is the load-bearing token; the suffix has varied across toolkit
// versions.
export function isCaveatExhaustedRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!reverted) return false;
  const reason = reverted.reason ?? reverted.shortMessage ?? '';
  return /ERC20TransferAmountEnforcer/i.test(reason) || /allowance.*exceeded/i.test(reason);
}

async function main(): Promise<void> {
  const mainPk  = (process.env.MAIN_PRIVATE_KEY ?? '').trim() as Hex;
  const rpcUrl  = (process.env.BASE_RPC_URL ?? '').trim();
  const baseUrl = (process.env.R402_BASE_URL ?? 'https://r402.rsynth.ai').replace(/\/$/, '');

  if (!/^0x[0-9a-fA-F]{64}$/.test(mainPk)) {
    console.error(C.red('MAIN_PRIVATE_KEY missing or malformed (need 0x + 64 hex).'));
    process.exit(1);
  }
  if (!rpcUrl) {
    console.error(C.red('BASE_RPC_URL not set.'));
    process.exit(1);
  }

  const mainEoa     = privateKeyToAccount(mainPk);
  const subPk       = deriveSubAgentKey(mainPk);
  const subAccount  = privateKeyToAccount(subPk);

  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const mainWallet   = createWalletClient({ account: mainEoa,    chain: base, transport: http(rpcUrl) });
  const subWallet    = createWalletClient({ account: subAccount, chain: base, transport: http(rpcUrl) });

  const mainSmart = await toMetaMaskSmartAccount({
    client:         publicClient,
    implementation: Implementation.Hybrid,
    deployParams:   [mainEoa.address, [], [], []],
    deploySalt:     '0x0000000000000000000000000000000000000000000000000000000000000000',
    signer:         { account: mainEoa },
  });

  console.log();
  console.log(C.bold('r402 sub-agent budget — base mainnet'));
  console.log();
  console.log(`  main:    ${mainSmart.address}  ${C.dim('(smart account, MetaMask Hybrid)')}`);
  console.log(`  sub:     ${subAccount.address}  ${C.dim('(EOA, derived from main)')}`);
  console.log(`  cap:     5.00 USDC`);
  console.log();

  // preflight: deploy main if needed
  const { factory, factoryData } = await mainSmart.getFactoryArgs();
  if (factory && factoryData) {
    const mainEth = await publicClient.getBalance({ address: mainEoa.address });
    if (mainEth < MIN_MAIN_ETH) {
      console.error(C.red(`  main EOA underfunded for deploy: ${formatEther(mainEth)} ETH, need ≥ ${formatEther(MIN_MAIN_ETH)} ETH`));
      console.error(C.dim(`  send ≥ ${formatEther(MIN_MAIN_ETH)} ETH to ${mainEoa.address} on base mainnet`));
      process.exit(1);
    }
    console.log(`  ${C.dim('main smart account not deployed — submitting SimpleFactory.deploy() ...')}`);
    const deployTx = await mainWallet.sendTransaction({ to: factory, data: factoryData });
    await publicClient.waitForTransactionReceipt({ hash: deployTx });
    console.log(`  main smart account deployed: ${mainSmart.address} ${C.dim('tx ' + deployTx)}`);
    console.log();
  }

  // preflight: USDC balance on main smart account
  const usdcBalance = await publicClient.readContract({
    address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [mainSmart.address],
  });
  if (usdcBalance < PREFLIGHT_USDC) {
    console.error(C.red(`  main smart account underfunded: ${formatUnits(usdcBalance, 6)} USDC, need ≥ 5.10 USDC`));
    console.error(C.dim(`  send ≥ 5.10 USDC to ${mainSmart.address} on base mainnet`));
    console.error(C.dim(`  (USDC contract: ${USDC_BASE})`));
    process.exit(1);
  }

  // preflight: sub-agent ETH for gas
  const subEth = await publicClient.getBalance({ address: subAccount.address });
  if (subEth < MIN_SUB_ETH) {
    console.error(C.red(`  sub-agent underfunded for gas: ${formatEther(subEth)} ETH, need ≥ ${formatEther(MIN_SUB_ETH)} ETH`));
    console.error(C.dim(`  send ≥ ${formatEther(MIN_SUB_ETH)} ETH to ${subAccount.address} on base mainnet`));
    process.exit(1);
  }

  // grant delegation
  const environment = mainSmart.environment;
  const delegation = createDelegation({
    from:        mainSmart.address,
    to:          subAccount.address,
    environment,
    scope: {
      type:         ScopeType.Erc20TransferAmount,
      tokenAddress: USDC_BASE,
      maxAmount:    CAP_USDC,
    },
  });
  const signature = await mainSmart.signDelegation({ delegation, chainId: CHAIN_ID });
  const signedDelegation = { ...delegation, signature };
  const digest = hashDelegation(signedDelegation);

  console.log(`  delegation granted ${C.dim('(erc20TransferAmount, max 5.00 USDC)')}`);
  console.log(`    → manager:  ${environment.DelegationManager}`);
  console.log(`    → caveat:   ERC20TransferAmountEnforcer @ ${environment.caveatEnforcers.ERC20TransferAmountEnforcer}`);
  console.log(`    → digest:   ${digest}`);
  console.log();

  const permissionContext = encodeDelegations([signedDelegation]);

  // loop 1..5
  for (let i = 1; i <= 5; i++) {
    console.log(`  ${C.dim('→')} call ${i}/5 ${C.dim(`(paying $1.00 USDC via x402 → ${PAY_TO.slice(0, 8)}...)`)}`);

    const execution = createExecution({
      target:   USDC_BASE,
      value:    0n,
      callData: encodeFunctionData({
        abi:          erc20Abi,
        functionName: 'transfer',
        args:         [subAccount.address, PER_CALL_USDC],
      }),
    });
    const executionCallData = encodeSingleExecution(execution);

    const redeemHash = await subWallet.writeContract({
      address:      environment.DelegationManager,
      abi:          DelegationManagerAbi,
      functionName: 'redeemDelegations',
      args:         [[permissionContext], [ExecutionMode.SingleDefault as Hex], [executionCallData]],
    });
    await publicClient.waitForTransactionReceipt({ hash: redeemHash });
    console.log(`       redeem: ${redeemHash}`);

    let verified: VerifyResponse;
    try {
      verified = await callWithX402<VerifyResponse>(
        `${baseUrl}/api/verify/${KNOWN_TX}`,
        'GET',
        undefined,
        subAccount,
      );
    } catch (err) {
      if (err instanceof X402Rejected) {
        console.error(C.red('  402 after retry — payment proof rejected.'));
        if (err.required) console.error(C.dim('  payment-required:'), err.required);
        process.exit(1);
      }
      throw err;
    }
    const signerOk = verified.signer.toLowerCase() === subAccount.address.toLowerCase();
    console.log(`       signer: ${verified.signer} (match: ${signerOk ? C.green('ok') : C.red('FAIL')})`);
    if (!signerOk) {
      console.error(C.red(`  mismatch — expected signer=${subAccount.address}`));
      process.exit(3);
    }
  }
  console.log();

  // 6th call — must revert at caveat enforcer
  console.log(`  ${C.dim('→')} call 6/5 ${C.dim('(attempting beyond cap)')}`);
  const overflowExecution = createExecution({
    target:   USDC_BASE,
    value:    0n,
    callData: encodeFunctionData({
      abi:          erc20Abi,
      functionName: 'transfer',
      args:         [subAccount.address, PER_CALL_USDC],
    }),
  });
  try {
    await subWallet.writeContract({
      address:      environment.DelegationManager,
      abi:          DelegationManagerAbi,
      functionName: 'redeemDelegations',
      args:         [[permissionContext], [ExecutionMode.SingleDefault as Hex], [encodeSingleExecution(overflowExecution)]],
    });
    // if we somehow get here the cap was not enforced
    console.error(C.red(`       redeem: 6th transfer succeeded — cap not enforced. demo failed.`));
    process.exit(2);
  } catch (err) {
    if (!isCaveatExhaustedRevert(err)) {
      console.error(C.red(`       redeem: reverted but not with the expected caveat error.`));
      console.error(C.dim(`       ${err instanceof Error ? err.message : String(err)}`));
      process.exit(4);
    }
    console.log(`       redeem: reverted at caveat enforcer ${C.dim('(ERC20TransferAmountEnforcer)')}`);
  }

  console.log();
  console.log(`  ${C.bold('budget exhausted. 5/5 used. ok.')}`);
  console.log();
  process.exit(1);
}

// guard so the test runner can import deriveSubAgentKey /
// isCaveatExhaustedRevert without firing the live demo.
import { fileURLToPath } from 'node:url';
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  main().catch((err) => {
    console.error(C.red('demo failed:'), err instanceof Error ? err.message : err);
    process.exit(99);
  });
}
