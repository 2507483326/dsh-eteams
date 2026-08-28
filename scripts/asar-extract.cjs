// One-shot: extract an asar member file to disk.
const fs = require('fs');
const [asarPath, memberPath, outPath] = process.argv.slice(2);
const buf = fs.readFileSync(asarPath);
const size = buf.readUInt32LE(4);
const headerLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + headerLen).toString('utf8'));
const dataStart = 8 + size;
let node = header;
for (const part of memberPath.split('/').filter(Boolean)) node = node.files[part];
fs.writeFileSync(
  outPath,
  buf.slice(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size),
);
console.log(`extracted ${memberPath} (${node.size} bytes) → ${outPath}`);
