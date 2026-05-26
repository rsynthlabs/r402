import { describe, it, expect } from 'vitest';
import {
  BaseError,
  ContractFunctionRevertedError,
  parseUnits,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createDelegation,
  getSmartAccountsEnvironment,
  ScopeType,
} from '@metamask/smart-accounts-kit';
import {
  deriveSubAgentKey,
  isCaveatExhaustedRevert,
} from '../examples/sub-agent-budget.js';

const FIXTURE_PK: Hex = ('0x' + 'a1'.repeat(32)) as Hex;
const USDC_BASE       = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

describe('deriveSubAgentKey', () => {
  it('produces a 64-hex-char private key deterministically', () => {
    const sub1 = deriveSubAgentKey(FIXTURE_PK);
    const sub2 = deriveSubAgentKey(FIXTURE_PK);
    expect(sub1).toBe(sub2);
    expect(sub1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('resolves to a stable address (golden) for the fixture private key', () => {
    const sub = deriveSubAgentKey(FIXTURE_PK);
    const account = privateKeyToAccount(sub);
    // pinned address — any change here means the derivation scheme changed
    // and existing sub-agent funding is now stranded; bump SUB_KEY_TAG and
    // update the golden if intentional.
    expect(account.address).toBe('0xE19b2AF310f2964a83a68C8a01ED75ad523c3Dfb');
  });

  it('rejects a malformed main private key', () => {
    expect(() => deriveSubAgentKey('not-hex' as Hex)).toThrow(/invalid main private key/);
    expect(() => deriveSubAgentKey(('0x' + 'a'.repeat(63)) as Hex)).toThrow(/invalid main private key/);
  });

  it('changes derived key when the tag changes', () => {
    const a = deriveSubAgentKey(FIXTURE_PK, 'tag-a');
    const b = deriveSubAgentKey(FIXTURE_PK, 'tag-b');
    expect(a).not.toBe(b);
  });
});

describe('createDelegation with Erc20TransferAmount scope on base mainnet', () => {
  const environment = getSmartAccountsEnvironment(8453);

  function build5UsdcDelegation() {
    return createDelegation({
      from:        '0x1111111111111111111111111111111111111111' as Hex,
      to:          '0x2222222222222222222222222222222222222222' as Hex,
      environment,
      scope: {
        type:         ScopeType.Erc20TransferAmount,
        tokenAddress: USDC_BASE,
        maxAmount:    parseUnits('5', 6),
      },
    });
  }

  it('pins delegator + delegate from the from/to fields', () => {
    const d = build5UsdcDelegation();
    expect(d.delegate).toBe('0x2222222222222222222222222222222222222222');
    expect(d.delegator).toBe('0x1111111111111111111111111111111111111111');
    // toolkit returns the unsigned shape; signature is filled by signDelegation
    expect(d.signature).toBe('0x');
  });

  it('attaches an ERC20TransferAmountEnforcer caveat to the base mainnet deployment', () => {
    const d = build5UsdcDelegation();
    const erc20Cav = d.caveats.find(
      (c) => c.enforcer.toLowerCase() ===
        environment.caveatEnforcers.ERC20TransferAmountEnforcer.toLowerCase(),
    );
    expect(erc20Cav).toBeDefined();
  });

  it('encodes the 5 USDC cap and USDC token address into the caveat terms', () => {
    const d = build5UsdcDelegation();
    const erc20Cav = d.caveats.find(
      (c) => c.enforcer.toLowerCase() ===
        environment.caveatEnforcers.ERC20TransferAmountEnforcer.toLowerCase(),
    )!;
    const terms = erc20Cav.terms.toLowerCase();
    // terms layout: 20-byte token address || 32-byte maxAmount (big-endian)
    // 5_000_000 = 0x4c4b40
    expect(terms).toContain(USDC_BASE.slice(2).toLowerCase());
    expect(terms).toMatch(/00000000000000000000000000000000000000000000000000000000004c4b40$/);
  });

  it('also installs a ValueLteEnforcer caveat (blocks native-value transfers)', () => {
    const d = build5UsdcDelegation();
    const valueLte = d.caveats.find(
      (c) => c.enforcer.toLowerCase() ===
        environment.caveatEnforcers.ValueLteEnforcer.toLowerCase(),
    );
    expect(valueLte).toBeDefined();
  });
});

describe('isCaveatExhaustedRevert', () => {
  function makeReverted(reason: string): BaseError {
    const inner = new ContractFunctionRevertedError({
      abi:          [],
      data:         '0x',
      functionName: 'redeemDelegations',
    });
    // viem's ContractFunctionRevertedError stores reason on the instance;
    // setting it directly here mirrors what viem does after decoding revert
    // data, without needing to thread real ABI/encoded data through the test.
    (inner as unknown as { reason: string }).reason = reason;
    const outer = new BaseError('execution reverted', { cause: inner });
    return outer;
  }

  it('matches the ERC20TransferAmountEnforcer string-revert (case-insensitive)', () => {
    expect(isCaveatExhaustedRevert(
      makeReverted('ERC20TransferAmountEnforcer:allowance-exceeded'),
    )).toBe(true);
    expect(isCaveatExhaustedRevert(
      makeReverted('erc20transferamountenforcer:something-else'),
    )).toBe(true);
  });

  it('matches "allowance exceeded" generic phrasing for forward-compat', () => {
    expect(isCaveatExhaustedRevert(
      makeReverted('allowance-exceeded'),
    )).toBe(true);
  });

  it('does not match unrelated reverts', () => {
    expect(isCaveatExhaustedRevert(makeReverted('insufficient gas'))).toBe(false);
    expect(isCaveatExhaustedRevert(makeReverted('execution reverted'))).toBe(false);
  });

  it('returns false for non-BaseError values', () => {
    expect(isCaveatExhaustedRevert(new Error('plain'))).toBe(false);
    expect(isCaveatExhaustedRevert(null)).toBe(false);
    expect(isCaveatExhaustedRevert(undefined)).toBe(false);
    expect(isCaveatExhaustedRevert('string')).toBe(false);
  });

  it('returns false when the BaseError has no ContractFunctionRevertedError in its cause chain', () => {
    const generic = new BaseError('rpc fetch failed');
    expect(isCaveatExhaustedRevert(generic)).toBe(false);
  });
});
