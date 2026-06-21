// offline cold-start harness for the bazaar discovery extension.
//
// reproduces a cold lambda without a deploy: the parent spawns a FRESH node
// process that imports the built server (cold module-load of the
// @x402/extensions/bazaar + ajv graph) and fires exactly one request with no
// warm-up. asserts the process does not crash (no non-zero exit / no "exit
// 128"), the status is 402, and the 402 envelope carries the bazaar discovery
// extension (extensions.bazaar) correctly.
//
// a local facilitator stub answers GET /supported so resourceServer.initialize()
// succeeds offline; without it the first request 500s on facilitator init and
// would mask the cold-start question.
//
// run: npm run test:cold-start   (builds first, then this)

import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const BUILT_SERVER = new URL('../dist/server.js', import.meta.url);

const TX = '0x' + 'a'.repeat(64);
const ROUTE_TEMPLATE = '/verify/:txHash';
const GENESIS_SIGNER = '0xe182BDa14ec3EfBAa72BC0fb6aad3145d9E64bAe';
const GENESIS_TXHASH = '0x713cf782481db82785853a56cb2b52f04fbfcc535d3bf9ffc1636f5c493cd7fb';
const NETWORK_ID   = 'eip155:8453';
const USDC_BASE    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE_AMOUNT = '1000000'; // $1.00 USDC, atomic - must match src/server.ts PRICE
const PAY_TO       = '0x132fA3855Dda4b2c085FCf3d79E9c3F15f78F15F';
const TIMEOUT_MS = 20_000;

// minimal facilitator /supported payload: exact on base mainnet, both protocol
// versions, so initialize() + validateRouteConfiguration() pass offline.
const SUPPORTED = {
  kinds: [
    { x402Version: 1, scheme: 'exact', network: 'eip155:8453' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
  ],
  extensions: [],
  signers: {},
};

async function parent() {
  if (!existsSync(BUILT_SERVER)) {
    console.error(`cold-start FAIL: ${fileURLToPath(BUILT_SERVER)} missing - run "npm run build" first`);
    process.exit(1);
  }

  const stub = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/supported') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SUPPORTED));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const facilitatorUrl = `http://127.0.0.1:${stub.address().port}`;

  const child = spawn(process.execPath, [SELF, '--child'], {
    env: { ...process.env, FACILITATOR_URL: facilitatorUrl, COLD_TX: TX },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ timedOut: true, code: null, signal: 'SIGKILL' });
    }, TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal });
    });
  });
  stub.close();

  const fail = (msg) => {
    console.error(`cold-start FAIL: ${msg}`);
    if (out.trim()) console.error('--- child stdout ---\n' + out.trim());
    if (err.trim()) console.error('--- child stderr ---\n' + err.trim());
    process.exit(1);
  };

  if (result.timedOut) fail(`child hung > ${TIMEOUT_MS}ms with no response (init race / deadlock)`);
  if (result.signal) fail(`child killed by signal ${result.signal} (native crash)`);
  if (result.code !== 0) fail(`child exited ${result.code} on cold boot${result.code === 128 ? ' ("exit 128")' : ''}`);

  const line = out.trim().split('\n').filter(Boolean).pop();
  let report;
  try {
    report = JSON.parse(line);
  } catch {
    return fail(`child emitted no JSON result line; raw stdout:\n${out.trim()}`);
  }
  if (!report.ok) return fail(report.error || 'child reported not-ok');

  console.log('cold-start PASS · fresh process, no crash · status 402 · extensions.bazaar present');
  console.log(`  method=${report.method} routeTemplate=${report.routeTemplate} pathParams=${JSON.stringify(report.pathParams)}`);
  console.log(`  output.example.signer=${report.exampleSigner}`);
  process.exit(0);
}

async function child() {
  const tx = process.env.COLD_TX || TX;
  // cold module-load of the bazaar -> ajv import graph in a brand-new process.
  const { createServer } = await import('../dist/server.js');
  const app = createServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  // exactly one request, no warm-up.
  const res = await fetch(`http://127.0.0.1:${port}/verify/${tx}`);

  const report = { ok: false, status: res.status };
  try {
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
    const header = res.headers.get('payment-required');
    if (!header) throw new Error('missing payment-required header');
    const envelope = JSON.parse(Buffer.from(header, 'base64').toString());
    if (envelope?.x402Version !== 2) throw new Error(`envelope.x402Version != 2 (${envelope?.x402Version})`);
    const accepts = Array.isArray(envelope?.accepts) ? envelope.accepts : [];
    if (accepts.length === 0) throw new Error('envelope.accepts missing/empty - unpayable 402');
    const req = accepts[0];
    if (req?.scheme !== 'exact') throw new Error(`accepts[0].scheme != exact (${req?.scheme})`);
    if (req?.network !== NETWORK_ID) throw new Error(`accepts[0].network != ${NETWORK_ID} (${req?.network})`);
    if (req?.asset?.toLowerCase() !== USDC_BASE.toLowerCase()) throw new Error(`accepts[0].asset != USDC (${req?.asset})`);
    if (req?.amount !== PRICE_AMOUNT) throw new Error(`accepts[0].amount != ${PRICE_AMOUNT} (${req?.amount})`);
    if (req?.payTo?.toLowerCase() !== PAY_TO.toLowerCase()) throw new Error(`accepts[0].payTo != ${PAY_TO} (${req?.payTo})`);
    const bazaar = envelope?.extensions?.bazaar;
    if (!bazaar) throw new Error('envelope.extensions.bazaar missing');
    const input = bazaar.info?.input;
    if (input?.type !== 'http') throw new Error(`bazaar.info.input.type != http (${input?.type})`);
    if (input?.method !== 'GET') throw new Error(`bazaar.info.input.method != GET (${input?.method})`);
    if (JSON.stringify(input?.pathParams) !== JSON.stringify({ txHash: tx }))
      throw new Error(`bazaar pathParams mismatch: ${JSON.stringify(input?.pathParams)}`);
    if (bazaar.routeTemplate !== ROUTE_TEMPLATE)
      throw new Error(`bazaar.routeTemplate != ${ROUTE_TEMPLATE} (${bazaar.routeTemplate})`);
    const example = bazaar.info?.output?.example;
    if (example?.signer !== GENESIS_SIGNER) throw new Error(`output.example.signer mismatch (${example?.signer})`);
    if (example?.txHash !== GENESIS_TXHASH) throw new Error(`output.example.txHash mismatch (${example?.txHash})`);
    report.ok = true;
    report.method = input.method;
    report.routeTemplate = bazaar.routeTemplate;
    report.pathParams = input.pathParams;
    report.exampleSigner = example.signer;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  }

  console.log(JSON.stringify(report));
  server.close();
  process.exit(report.ok ? 0 : 1);
}

if (process.argv.includes('--child')) {
  child();
} else {
  parent();
}
