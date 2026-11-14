import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
let server = readFileSync(resolve(root, 'src/server.js'), 'utf8');
for (const [token, file] of [
  ['__HTML__', 'src/app.html'],
  ['__CSS__', 'src/app.css'],
  ['__CLIENT__', 'src/app.js'],
  ['__ENGINE__', 'src/engine.js'],
]) {
  server = server.replace(token, JSON.stringify(readFileSync(resolve(root, file), 'utf8')));
}
server = server.replace('__ACCOUNT__', readFileSync(resolve(root, 'src/account.js'), 'utf8'));
writeFileSync(resolve(root, 'worker/index.js'), server);
console.log('Generated worker/index.js');
