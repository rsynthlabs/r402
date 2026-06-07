import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { callWithX402, type VerifyResponse } from '../examples/buyer.js';

const GENESIS = '0x713cf782481db82785853a56cb2b52f04fbfcc535d3bf9ffc1636f5c493cd7fb' as Hex;
const EXPECT_SIGNER = '0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe';
const EXPECT_HASH   = '0xf4956c73088b2e375ae322a452d80fdd52634707288820916eb01445f4a92b12';

async function main() {
  const pk = (process.env.BUYER_PRIVATE_KEY ?? '').trim() as Hex;
  const baseUrl = (process.env.R402_BASE_URL ?? 'https://r402.rsynth.ai').replace(/\/$/, '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error('BUYER_PRIVATE_KEY missing/malformed'); process.exit(1); }
  const account = privateKeyToAccount(pk);
  const url = `${baseUrl}/api/verify/${GENESIS}`;

  console.log(`GET ${url}  (paying $1.00 USDC via x402)`);
  let v: VerifyResponse;
  try {
    v = await callWithX402<VerifyResponse>(url, 'GET', undefined, account);
  } catch (e: any) {
    if (e?.status === 404) { console.log('404 — 5s RPC propagation...'); await new Promise(r=>setTimeout(r,5000));
      v = await callWithX402<VerifyResponse>(url, 'GET', undefined, account);
    } else throw e;
  }

  console.log('\n--- RAW 200 BODY ---');
  console.log(JSON.stringify(v, null, 2));
  console.log('--- END ---\n');

  const signerOk = v.signer.toLowerCase() === EXPECT_SIGNER.toLowerCase();
  const hashOk   = v.payloadHash.toLowerCase() === EXPECT_HASH.toLowerCase();
  console.log(`signer match: ${signerOk ? 'ok' : 'FAIL'}  (${v.signer})`);
  console.log(`hash   match: ${hashOk ? 'ok' : 'FAIL'}  (${v.payloadHash})`);
  process.exit(signerOk && hashOk ? 0 : 3);
}
main().catch(e => { console.error('verify failed:', e?.message ?? e); process.exit(2); });
