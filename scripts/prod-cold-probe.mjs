// prod cold-boot probe for the bazaar discovery verify route.
//
// fire ONE request at a freshly-redeployed prod alias (a fresh deploy is cold)
// and assert the cold lambda does NOT 500: the response is HTTP 402 and the 402
// envelope carries the bazaar discovery extension. this is the prod proof for
// the pinned-facilitator fix (src/server.ts) - green-local is necessary but the
// real gate is this probe run immediately after the redeploy.
//
// a cold-boot 500 / 502 / FUNCTION_INVOCATION_FAILED, a thrown request (no
// response), or a missing bazaar extension all FAIL loudly.
//
// usage: npm run prod-cold-probe -- https://<prod-alias> [txHash]

const [, , rawUrl, rawTx] = process.argv;

if (!rawUrl) {
  console.error('prod-cold-probe FAIL: missing prod alias url');
  console.error('usage: npm run prod-cold-probe -- https://<prod-alias> [txHash]');
  process.exit(2);
}

const base = rawUrl.replace(/\/+$/, '');
const tx = rawTx || '0x' + 'a'.repeat(64);
const url = `${base}/verify/${tx}`;
const ROUTE_TEMPLATE = '/verify/:txHash';
const GENESIS_SIGNER = '0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe';
const GENESIS_TXHASH = '0x713cf782481db82785853a56cb2b52f04fbfcc535d3bf9ffc1636f5c493cd7fb';
const NETWORK_ID   = 'eip155:8453';
const USDC_BASE    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE_AMOUNT = '1000000'; // $1.00 USDC, atomic - must match src/server.ts PRICE
const PAY_TO       = '0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F';
const TIMEOUT_MS = 30_000;

function fail(msg, extra) {
  console.error(`prod-cold-probe FAIL: ${msg}`);
  if (extra) console.error(`--- ${extra.label} ---\n${extra.body}`);
  process.exit(1);
}

// exactly one request, no warm-up. accept: application/json forces the machine
// (non-paywall-html) branch so the 402 envelope lands in the header.
let res;
try {
  res = await fetch(url, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (e) {
  fail(`request threw - cold lambda crash / no response: ${e instanceof Error ? e.message : String(e)}`);
}

if (res.status !== 402) {
  const body = await res.text().catch(() => '<no body>');
  fail(`expected 402, got ${res.status} (cold-boot regression if 5xx)`, {
    label: `${res.status} body`,
    body: body.slice(0, 800),
  });
}

const header = res.headers.get('payment-required');
if (!header) fail('402 but no payment-required header');

let envelope;
try {
  envelope = JSON.parse(Buffer.from(header, 'base64').toString());
} catch (e) {
  fail(`payment-required header is not base64 json: ${e instanceof Error ? e.message : String(e)}`);
}

// envelope-level payment-requirements sanity. a cold 402 with a valid bazaar
// extension but a broken/empty accepts is still a regression (unpayable challenge).
if (envelope?.x402Version !== 2)
  fail(`envelope.x402Version != 2 (${envelope?.x402Version})`);
const accepts = Array.isArray(envelope?.accepts) ? envelope.accepts : [];
if (accepts.length === 0) fail('envelope.accepts missing/empty - unpayable 402');
const req = accepts[0];
if (req?.scheme !== 'exact')      fail(`accepts[0].scheme != exact (${req?.scheme})`);
if (req?.network !== NETWORK_ID)  fail(`accepts[0].network != ${NETWORK_ID} (${req?.network})`);
if (req?.asset?.toLowerCase() !== USDC_BASE.toLowerCase()) fail(`accepts[0].asset != USDC (${req?.asset})`);
if (req?.amount !== PRICE_AMOUNT) fail(`accepts[0].amount != ${PRICE_AMOUNT} (${req?.amount})`);
if (req?.payTo?.toLowerCase() !== PAY_TO.toLowerCase())    fail(`accepts[0].payTo != ${PAY_TO} (${req?.payTo})`);

const bazaar = envelope?.extensions?.bazaar;
if (!bazaar) fail('envelope.extensions.bazaar missing - discovery not on the cold 402');

const input = bazaar.info?.input;
if (input?.type !== 'http') fail(`bazaar.info.input.type != http (${input?.type})`);
if (input?.method !== 'GET') fail(`bazaar.info.input.method != GET (${input?.method})`);
if (bazaar.routeTemplate !== ROUTE_TEMPLATE)
  fail(`bazaar.routeTemplate != ${ROUTE_TEMPLATE} (${bazaar.routeTemplate})`);

const example = bazaar.info?.output?.example;
if (example?.signer !== GENESIS_SIGNER) fail(`output.example.signer mismatch (${example?.signer})`);
if (example?.txHash !== GENESIS_TXHASH) fail(`output.example.txHash mismatch (${example?.txHash})`);

console.log('prod-cold-probe PASS · no crash · status 402 · extensions.bazaar present');
console.log(`  url=${url}`);
console.log(`  method=${input.method} routeTemplate=${bazaar.routeTemplate} pathParams=${JSON.stringify(input.pathParams)}`);
console.log(`  output.example.signer=${example.signer}`);
process.exit(0);
