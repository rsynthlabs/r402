import { describe, it, expect } from 'vitest';
import { recoverMessageAddress } from 'viem';

// locks the EIP-191 prefix boundary against a fixture computed by the Python
// SDK. PAYLOAD_HASH matches SCHEMA_EXAMPLE_HASH in tests/canonical.test.ts —
// signing the same canonical-encoded payload ties the two boundaries together.

describe('verify (crosslang boundary)', () => {
  it('viem recovers the same signer as the Python SDK', async () => {
    const PAYLOAD_HASH =
      '0x26444c4ba73c1f692533ddcf1827e56f5cefe27cbbd169c87ff11c443e99aa8d' as const;
    const SIG =
      '0xfb2c5b4fc6ab2a10b3026da227d1419529c7ac84f56779bdf3b862eebdec410208bed0e00f2465d76f935a95e5abce64e064546a6c9a5a59e3336e578877ff9c1c' as const;
    const EXPECTED = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

    const recovered = await recoverMessageAddress({
      message: { raw: PAYLOAD_HASH },
      signature: SIG,
    });

    expect(recovered.toLowerCase()).toBe(EXPECTED.toLowerCase());
  });
});
