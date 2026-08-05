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
// 保留白名单: 历史引用句 + 外部发布物/URL + 语义无关的 open(动词)前缀。
const PRESERVE = /(OpenWork is|fork of OpenWork|respectively)/i;
// A1 验收结论: 残余 openwork 仅为以下可接受类别(外部真实引用/语义标识符),
// 而非品牌残留。若未来出现歧叠此处模式的品牌残留, 需人工 review。
const ACCEPTABLE = [
  // 外部真实发布链接/域名 (不可改, 否则断裂下载/外链)
  "github.com/different-ai/openwork",
  "openworklabs.com",
  "ttl.sh/openwork",
  // open(动词)+Work 开头的语义标识符 (非品牌), 如 openWorkbenchTab/OpenWorkspaceSettings/OpenWorkModels
  /openWork(bench|space|Models|Sandbox)/,
  // MySQL 数据库库名 openwork_den (运行时数据标识, plan 保留 db 名)
  "openwork_den",
  // DER 二进制测试证书主题 (含 OpenWork 字节, 不可安全重命名)
  "intermediate.der",
];
function isAccepted(ln) {
  if (PRESERVE.test(ln)) return true;
  if (preserveSubstrings.some((s) => ln.toLowerCase().includes(s.toLowerCase()))) return true;
  return ACCEPTABLE.some((a) => (typeof a === "string" ? ln.includes(a) : a.test(ln)));
}
let worst = 0;

function walk(base, rel = "") {
  for (const name of readdirSync(base)) {
    const p = join(base, name);
    const relP = rel ? `${rel}/${name}` : name;
    // 以完整相对路径匹配, 避免 basename 与含斜线条目永不匹配的问题。
    if (SKIP_RELPATHS.has(relP)) continue;
    if (SKIP_DIRS.has(name)) continue;
    if (statSync(p).isDirectory()) { walk(p, relP); continue; }
    // 跳过二进制/图片/字体/TSo .tsbuildinfo 缓存等非 UTF-8 或机器生成文本。
    if (/\.(der|png|gif|jpg|jpeg|ico|woff2?|ttf|eot|keystore|p12|pem|crt|tsbuildinfo)(\.|$)/.test(name)) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (ln.toLowerCase().includes("openwork") && !isAccepted(ln)) {
        console.log(`残留: ${p}:${i + 1}: ${ln.trim()}`);
        worst++;
      }
    });
  }
}

walk(root);
if (worst > 0) { console.error(`FAIL: ${worst} 处 openwork 残留(白名单外)`); process.exit(1); }
console.log("OK: 仓内无 openwork 残留(白名单外)");