// One-shot: enumerate route paths registered across host bundles in the asar.
const fs = require('fs');
const buf = fs.readFileSync('C:/Users/epat/AppData/Local/Programs/DSH Desktop/resources/app.asar');
const size = buf.readUInt32LE(4);
const headerLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + headerLen).toString('utf8'));
const dataStart = 8 + size;
const files = [];
(function walk(node, prefix) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
  } else if (
    typeof node.offset === 'string' &&
    node.size < 4000000 &&
    /lib\/(index|main|client)\.js$/.test(prefix)
  )
    files.push({ file: prefix, offset: Number(node.offset), size: node.size });
})(header, '');
const re = /path:\s*["'](\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)["']/g;
const seen = new Map();
for (const f of files) {
  const text = buf.slice(dataStart + f.offset, dataStart + f.offset + f.size).toString('utf8');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[1])) seen.set(m[1], f.file);
  }
}
console.log(
  [...seen.entries()]
    .map(([p, f]) => p + '   [' + f + ']')
    .sort()
    .join('\n'),
);
