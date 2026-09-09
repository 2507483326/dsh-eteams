// 临时诊断:列出会话全部事件类型时间线(含 command)。
const fs = require('fs');
const zlib = require('node:zlib');
const file = process.argv[2];
const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const frames = [];
let idx = buf.indexOf(MAGIC);
while (idx >= 0) {
  const next = buf.indexOf(MAGIC, idx + 1);
  frames.push(buf.subarray(idx, next < 0 ? buf.length : next));
  idx = next;
}
let text = '';
for (const f of frames) {
  try { text += zlib.zstdDecompressSync(f).toString('utf8'); } catch {}
}
for (const line of text.split('\n')) {
  const l = line.trim();
  if (l === '') continue;
  let e;
  try { e = JSON.parse(l); } catch { continue; }
  const t = e.type ?? '?';
  if (t === 'assistant/chunk' || t === 'reasoning-chunks') continue;
  let extra = '';
  if (t === 'command/run') extra = (e.data?.name ?? '') + ' ' + String(e.data?.args ?? '').slice(0, 60);
  if (t === 'tool/call') extra = e.data?.name;
  if (t === 'user/message') extra = 'kind=' + (e.data?.source?.kind ?? '?') + ' form=' + (e.data?.source?.form ?? '-') + ' | ' + (Array.isArray(e.data?.content) ? e.data.content.map((b) => b.text ?? '').join(' ') : '').slice(0, 90);
  if (t === 'turn/end') extra = JSON.stringify(e.data ?? {});
  console.log(new Date(e.time).toLocaleTimeString(), t, extra);
}
