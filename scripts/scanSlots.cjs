const fs = require('fs');
const buf = fs.readFileSync('C:/Users/epat/AppData/Local/Programs/DSH Desktop/resources/app.asar');
// extract ASCII string literals that look like slot names / module ids
const text = buf.toString('latin1');
const patterns = [/conversation\.[a-zA-Z]+\.[a-zA-Z.]+/g, /shell\.[a-zA-Z]+\.[a-zA-Z.]+/g];
const found = new Set();
for (const p of patterns) {
  let m;
  while ((m = p.exec(text))) found.add(m[0]);
}
const arr = [...found].sort();
console.log('--- conversation.* / shell.* identifiers ---');
for (const s of arr) console.log(s);
console.log('total: ' + arr.length);
