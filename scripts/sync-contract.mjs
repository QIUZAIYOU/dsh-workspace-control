/**
 * One source for the Remote contract.
 *
 * The host file is canonical; the Client bundle cannot `import` it (the Module
 * Loader hands a bundle `require` for externals, not a module graph), so the
 * descriptor list is a generated mirror. This script is the generator, and it is
 * also the gate: `npm test` runs it without `--write`, so a host change that is
 * not mirrored fails here before `test/contract.test.js` even loads a page.
 *
 *   node scripts/sync-contract.mjs          # check, exit 1 on drift
 *   node scripts/sync-contract.mjs --write  # rewrite the client mirror
 */
import { readFileSync, writeFileSync } from 'node:fs';

const HOST = new URL('../index.js', import.meta.url);
const CLIENT = new URL('../client.js', import.meta.url);
const HOST_HEAD = 'export const DESCRIPTORS = Object.freeze([';
const CLIENT_HEAD = '    const DESCRIPTORS = Object.freeze([';
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const read = (url) => {
  const raw = readFileSync(url, 'utf8');
  const crlf = raw.includes(CRLF);
  return { crlf, text: crlf ? raw.split(CRLF).join(LF) : raw };
};

const slice = (text, head) => {
  const start = text.indexOf(head);
  if (start < 0) throw new Error(`cannot find ${head}`);
  const end = text.indexOf(']);', start);
  if (end < 0) throw new Error('cannot find the end of the descriptor list');
  return { start, end: end + 3, body: text.slice(start + head.length, end) };
};

const lines = (body) =>
  body
    .split(LF)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));

const host = read(HOST);
const client = read(CLIENT);
const hostBlock = slice(host.text, HOST_HEAD);
const clientBlock = slice(client.text, CLIENT_HEAD);

const a = lines(hostBlock.body);
const b = lines(clientBlock.body);

if (a.length === b.length && a.every((line, index) => line === b[index])) {
  console.log(`contract: mirrored (${a.length} lines)`);
  process.exit(0);
}

const index = a.findIndex((line, i) => line !== b[i]);
console.error(`contract: the Client mirror has drifted from index.js at line ${index + 1}`);
console.error(`  host:   ${a[index] ?? '<missing>'}`);
console.error(`  client: ${b[index] ?? '<missing>'}`);

if (!process.argv.includes('--write')) {
  console.error('run `npm run sync:contract` to regenerate the mirror');
  process.exit(1);
}

const rewritten =
  CLIENT_HEAD +
  LF +
  hostBlock.body
    .split(LF)
    .map((line) => (line.trim() === '' ? line : `    ${line}`))
    .join(LF) +
  ']);';

const next = client.text.slice(0, clientBlock.start) + rewritten + client.text.slice(clientBlock.end);
writeFileSync(CLIENT, client.crlf ? next.split(LF).join(CRLF) : next, 'utf8');
console.log('contract: client mirror regenerated');
