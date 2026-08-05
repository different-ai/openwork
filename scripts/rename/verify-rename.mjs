// scripts/rename/verify-rename.mjs
// 断言: 全仓不存在未替换的 openwork(除 PRESERVE 白名单)。exit 非0 → fail。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const SKIP = new Set(["node_modules", ".git", "scripts/rename", "plan", "dist", "build", ".next"]);
// 保留白名单: 仅保留真实的"历史引用句"。
const PRESERVE = /(OpenWork is|fork of OpenWork|respectively)/i;
let worst = 0;

function walk(base) {
  for (const name of readdirSync(base)) {
    if (SKIP.has(name)) continue;
    const p = join(base, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (ln.toLowerCase().includes("openwork") && !PRESERVE.test(ln)) {
        console.log(`残留: ${p}:${i + 1}: ${ln.trim()}`);
        worst++;
      }
    });
  }
}

walk(root);
if (worst > 0) { console.error(`FAIL: ${worst} 处 openwork 残留(白名单外)`); process.exit(1); }
console.log("OK: 仓内无 openwork 残留(白名单外)");