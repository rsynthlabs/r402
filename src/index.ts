import { createServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3000);
createServer().listen(PORT, () => {
  console.log(`r402 listening on :${PORT}`);
});
