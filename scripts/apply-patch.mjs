// OpenWork 简体中文翻译 —— 本地一键补丁脚本
// ------------------------------------------------------------------
// 作用：把 zh-missing-translations.ts（缺失键，插入）与
//       zh-fix-translations.ts（修复键，替换或插入）中的中文翻译
//       注入本地安装的 OpenWork 桌面应用 UI bundle
//       （resources/app-dist/assets/app-*.js）
// 用法：node apply-zh-patch.mjs
// 前提：本机已安装 OpenWork 桌面应用；脚本与两个翻译文件在同一目录
// 注意：
//   1. 运行前请完全退出 OpenWork（否则文件可能被占用）
//   2. 应用更新（升级版本）会覆盖 app-dist，升级后需重新运行本脚本
//   3. 原文件会自动备份为 app-*.js.bak（首次运行时）
//   4. 已打补丁的 bundle 再次运行 → 增量修复模式：仅替换/插入修复集
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const APP_DIR = process.env.OW_APP_DIR ?? 'C:/Users/admin/AppData/Local/Programs/@openworkdesktop/resources/app-dist/assets';
const missingPath = path.join(import.meta.dirname, 'zh-missing-translations.ts');
const fixPath = path.join(import.meta.dirname, 'zh-fix-translations.ts');

const zhMarker = '\u538b\u7f29\u6b64\u4f1a\u8bdd'; // "压缩此会话"（zh 对象特征）
const insertedProbe = '\u5df2\u8fde\u63a5{count}\u4e2aMCP'; // 已插入条目的特征串

function parseTs(file) {
  const ts = fs.readFileSync(file, 'utf8');
  const pairs = [];
  for (const m of ts.matchAll(/"([a-zA-Z0-9_.\-]+)":\s*"((?:[^"\\]|\\.)*)",/g)) {
    pairs.push([m[1], m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n')]);
  }
  return pairs;
}

function escapeVal(v) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findBundle() {
  if (!fs.existsSync(APP_DIR)) throw new Error('未找到 OpenWork 安装目录: ' + APP_DIR);
  const files = fs.readdirSync(APP_DIR).filter((f) => /^app-[A-Za-z0-9_-]+\.js$/.test(f));
  if (files.length !== 1) throw new Error('app bundle 匹配数异常: ' + files.join(', '));
  return path.join(APP_DIR, files[0]);
}

// 定位对象结束（字符串感知的括号配对，支持双引号与反引号模板字符串）
// 注意：从 startIdx（即 '{' 本身）开始，使起始 '{' 计入 depth=1
function findObjEnd(t, startIdx) {
  let i = startIdx, depth = 0, inStr = false, esc = false, quote = '"';
  for (; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
    } else {
      if (c === '"' || c === '`' || c === "'") { inStr = true; quote = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
  }
  throw new Error('对象结束未找到');
}

const bundlePath = findBundle();
let t;
try { t = fs.readFileSync(bundlePath, 'utf8'); }
catch { throw new Error('无法读取 bundle（请先完全退出 OpenWork 再运行本脚本）: ' + bundlePath); }

const alreadyApplied = t.includes(insertedProbe);

// 1) 解析翻译文件
const missingPairs = parseTs(missingPath); // 插入集
const fixPairs = parseTs(fixPath);         // 修复集
if (missingPairs.length < 600) throw new Error('缺失翻译文件解析异常，条目数: ' + missingPairs.length);
if (fixPairs.length < 40) throw new Error('修复翻译文件解析异常，条目数: ' + fixPairs.length);

// 2) 定位 zh 翻译对象
const marker = t.indexOf(zhMarker);
if (marker < 0) throw new Error('bundle 中未找到 zh 翻译对象（版本不兼容？）');
const zhObjStart = t.lastIndexOf('{...hu,', marker);
if (zhObjStart < 0) throw new Error('bundle 中未找到 zh 对象起始');
const zhObjEnd = findObjEnd(t, zhObjStart);

// 3) 已存在的键
// 注意：zhObjEnd 是 '}' 的索引，slice 须 +1 才包含闭合花括号
const core = t.slice(zhObjStart, zhObjEnd + 1);
const existing = new Set();
for (const m of core.matchAll(/"([a-zA-Z0-9_.\-]+)":/g)) existing.add(m[1]);

// 4) 插入集：缺失键追加
let core2 = core;
const insertParts = [];
const insertedKeys = new Set(); // 记录已加入 insertParts 的键，防止 missing/fix 重叠重复插入
let inserted = 0, skipped = 0;
for (const [k, v] of missingPairs) {
  if (existing.has(k)) { skipped++; continue; }
  if (insertedKeys.has(k)) continue;
  insertParts.push(`"${k}":"${escapeVal(v)}",`);
  insertedKeys.add(k);
  inserted++;
}

// 5) 修复集：已存在 → 值不同才替换；不存在 → 追加（跳过已在插入集的键）
let replaced = 0;
for (const [k, v] of fixPairs) {
  if (existing.has(k)) {
    const re = new RegExp('"' + k + '":\\s*"((?:[^"\\\\]|\\\\.)*)"');
    const m = re.exec(core2);
    if (m) {
      // 当前值已是目标值 → 跳过（真正幂等）
      if (m[1] === v) { skipped++; continue; }
      core2 = core2.replace(re, '"' + k + '":"' + escapeVal(v) + '"');
      replaced++;
    } else {
      if (insertedKeys.has(k)) continue;
      insertParts.push(`"${k}":"${escapeVal(v)}",`);
      insertedKeys.add(k);
      inserted++;
    }
  } else {
    if (insertedKeys.has(k)) continue;
    insertParts.push(`"${k}":"${escapeVal(v)}",`);
    insertedKeys.add(k);
    inserted++;
  }
}

if (inserted === 0 && replaced === 0) {
  console.log('无需修改（所有键均已存在且无需替换）。');
  process.exit(0);
}

// 6) 备份 + 组装新对象
//    关键修复：insertParts 为空时绝不拼逗号；先剥掉 core2 末尾可能的残留尾逗号（第一次补丁留下的 ",}"），
//    再从对象尾部拼接，确保不会出现 ",," 或 ",}"。
const bak = bundlePath + '.bak';
if (!fs.existsSync(bak)) fs.copyFileSync(bundlePath, bak);
const base = core2.slice(0, core2.length - 1).replace(/,\s*$/, ''); // 去掉 '}' 并清理尾逗号
// join 后去掉末尾逗号（每项自带 ','），避免产生尾逗号 ",}"
const ins = insertParts.length ? ',' + insertParts.join('').replace(/,$/, '') : '';
const core3 = base + ins + '}';
const newBundle = t.slice(0, zhObjStart) + core3 + t.slice(zhObjEnd + 1);

// 7) 写盘前验证：AAe 对象字面量语法必须合法（vm 解析，与浏览器/Electron 一致）
try {
  vm.runInNewContext('const hu={};const __zh=' + core3 + ';__zh;', {}, { timeout: 10000 });
} catch (e) {
  console.error('语法验证失败，未写入任何文件！');
  console.error(e.name + ': ' + e.message);
  process.exit(1);
}

// 8) 写盘 + 写后验证
fs.writeFileSync(bundlePath, newBundle, 'utf8');
const check = fs.readFileSync(bundlePath, 'utf8');
const ckStart = check.indexOf('{...hu,', check.lastIndexOf('压缩此会话'));
const ckEnd = findObjEnd(check, ckStart);
try {
  vm.runInNewContext('const hu={};const __zh=' + check.slice(ckStart, ckEnd + 1) + ';__zh;', {}, { timeout: 10000 });
  console.log('写后验证通过：bundle 语法合法。');
} catch (e) {
  console.error('写后验证失败！尝试从备份恢复…');
  fs.copyFileSync(bak, bundlePath);
  console.error('已恢复备份: ' + bak);
  process.exit(1);
}

console.log('已打补丁: ' + bundlePath);
console.log('模式: ' + (alreadyApplied ? '增量修复（已打补丁）' : '全量插入'));
console.log('插入 ' + inserted + ' 条，替换 ' + replaced + ' 条，跳过已存在 ' + skipped + ' 条');
console.log('备份: ' + bak);
console.log('请完全退出并重新打开 OpenWork 以生效。应用更新后请重新运行本脚本。');
