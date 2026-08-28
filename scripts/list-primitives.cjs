// One-shot: enumerate exported component names from the DSH primitives bundle.
const fs = require('fs');
const asar = 'C:/Users/epat/AppData/Local/Programs/DSH Desktop/resources/app.asar';
const buf = fs.readFileSync(asar);
const size = buf.readUInt32LE(4);
const headerLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + headerLen).toString('utf8'));
const dataStart = 8 + size;
function memberText(file) {
  let node = header;
  for (const part of file.split('/').filter(Boolean)) node = node.files[part];
  return buf
    .slice(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size)
    .toString('utf8');
}
const idx = memberText('node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js');
// export { X, Y as Z } from ... / export { A, B }
const names = new Set();
for (const m of idx.matchAll(/export\s*\{([^}]+)\}(?:\s*from)?/g)) {
  for (const part of m[1].split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const as = seg.match(/([\w$]+)\s+as\s+([\w$]+)/);
    names.add(as ? as[2] : seg);
  }
}
console.log([...names].sort().join('\n'));
console.log('--- total:', names.size);
// also: does the app bundle ship headlessui / radix?
for (const needle of ['headlessui', '@radix-ui', 'radix-ui', 'ark-ui', '@floating-ui']) {
  const nbuf = Buffer.from(needle);
  const count = countIn(buf, nbuf);
  console.log(needle + ': ' + count + ' hits');
}
function countIn(buf, nbuf) {
  let n = 0;
  let i = buf.indexOf(nbuf);
  while (i !== -1) {
    n += 1;
    i = buf.indexOf(nbuf, i + 1);
  }
  return n;
}
