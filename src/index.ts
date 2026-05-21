import { createServer } from './server.js';

export { canonicalBytes, payloadHash } from './canonical.js';
export { verifyAnchor, type VerifyResult } from './verify.js';

const PORT = Number(process.env.PORT ?? 3000);
createServer().listen(PORT, () => {
  console.log(`r402 listening on :${PORT}`);
});
