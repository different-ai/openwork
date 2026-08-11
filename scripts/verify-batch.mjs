// 字典区命中检查：确认某批翻译的所有 from 串都不会命中文档词典区（du/CAe/EAe/AAe/RAe/IAe/jAe/TAe/OAe/NAe/PAe）
// 用法: node verify-batch.mjs <测试用 bundle 副本> <翻译表.mjs>
// 输出: entries / dict zone hits（应为 0；>0 说明该串位于语言包词典内，属于词典值而非代码区文案，需改用补键方式处理）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [testFile, batchFile] = process.argv.slice(2);
const t = fs.readFileSync(testFile, 'utf8');
function findObjEnd(src, startIdx) {
  let i = startIdx, depth = 0, inStr = false, esc = false, quote = '"';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === quote) inStr = false; }
    else { if (c === '"' || c === '`' || c === "'") { inStr = true; quote = c; } else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return i; } }
  }
  return -1;
}
const ranges = [];
for (const name of ['du=', 'CAe=', 'EAe=', 'AAe=', 'RAe=', 'IAe=', 'jAe=', 'TAe=', 'OAe=', 'NAe=', 'PAe=']) {
  const i = t.indexOf(name + '{');
  if (i < 0) continue;
  ranges.push({ name, start: i + name.length, end: findObjEnd(t, i + name.length) });
}
const mod = await import(pathToFileURL(path.resolve(batchFile)).href);
const reps = mod.default;
let dictHit = [];
for (const [from] of reps) {
  let i = 0;
  while ((i = t.indexOf(from, i)) >= 0) {
    const h = ranges.find(r => i >= r.start && i <= r.end);
    if (h) dictHit.push([from.slice(0, 50), h.name]);
    i += from.length;
  }
}
console.log('entries:', reps.length, ' dict zone hits:', dictHit.length, dictHit);
