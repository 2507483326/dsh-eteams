import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const path = `${homedir()}\\.eteams\\logs\\client.log`;
const lines = readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() !== '');

const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
const seen = new Set();
const out = [];
for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  const e = parsed.entry ?? {};
  const key = `${e.at}|${e.kind}|${String(e.message).slice(0, 120)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(`${fmt(e.at)} [${e.kind}] ${String(e.message).slice(0, 260)}`);
}
console.log('unique entries:', out.length);
console.log(out.slice(-25).join('\n'));
