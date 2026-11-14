import http from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../dist/server/index.js';
import { createLocalDb } from './local-db.mjs';

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, '.env.local'))) process.loadEnvFile(resolve(root, '.env.local'));
const port = Number(process.env.PORT || 4173);
const env = { DB: createLocalDb(resolve(root, '.local/preview.sqlite')), FUYAO_API_KEY: process.env.FUYAO_API_KEY, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || process.env.TEST_DEEPSEEK_KEY };

http.createServer(async (incoming, outgoing) => {
  try {
    const body = [];
    for await (const chunk of incoming) body.push(chunk);
    const request = new Request(`http://localhost:${port}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(body.length ? { body: Buffer.concat(body), duplex: 'half' } : {}),
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end(`Local preview error: ${error?.message || 'unknown'}`);
  }
}).listen(port, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${port}`));
