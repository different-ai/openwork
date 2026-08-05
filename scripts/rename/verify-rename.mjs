// scripts/rename/verify-rename.mjs
// 断言: 全仓不存在未替换的 openwork(除保留白名单)。exit 非0 → fail。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);
// 按完整相对路径(相对 cwd)跳过的文件/目录, 覆盖脚本工具自身与保留子树。
const SKIP_RELPATHS = new Set(["scripts/rename", "plan"]);
// 保留白名单真源来自 rename-map.json; 另保留真实的历史引用句。
const { preserveSubstrings } = JSON.parse(
  readFileSync(join("scripts", "rename", "rename-map.json"), "utf8"),
);
const PRESERVE = /(OpenWork is|fork of OpenWork|respectively)/i;
const preserveAny = (ln) => {
  if (PRESERVE.test(ln)) return true;
  return preserveSubstrings.some((s) => ln.toLowerCase().includes(s.toLowerCase()));
};
let worst = 0;

function walk(base, rel = "") {
  for (const name of readdirSync(base)) {
    const p = join(base, name);
    const relP = rel ? `${rel}/${name}` : name;
    // 以完整相对路径匹配, 避免 basename 与含斜线条目永不匹配的问题。
    if (SKIP_RELPATHS.has(relP)) continue;
    if (SKIP_DIRS.has(name)) continue;
    if (statSync(p).isDirectory()) { walk(p, relP); continue; }
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (ln.toLowerCase().includes("openwork") && !preserveAny(ln)) {
        console.log(`残留: ${p}:${i + 1}: ${ln.trim()}`);
        worst++;
      }
    });
  }
}

walk(root);
if (worst > 0) { console.error(`FAIL: ${worst} 处 openwork 残留(白名单外)`); process.exit(1); }
console.log("OK: 仓内无 openwork 残留(白名单外)");