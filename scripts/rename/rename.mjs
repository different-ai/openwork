// scripts/rename/rename.mjs
// A1 全仓重命名脚本: 输入映射表, 对指定目录做文件级令牌替换。
// 用法: node scripts/rename/rename.mjs --dir apps --map scripts/rename/rename-map.json
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [, , ...argv] = process.argv;
const arg = (k) => {
  const i = argv.findIndex((x) => x === k);
  return i >= 0 ? argv[i + 1] : null;
};

const root = process.cwd();
const dir = arg("--dir") || ".";
const mapPath = arg("--map") || "scripts/rename/rename-map.json";
const includeOnly = arg("--include-only") || ""; // 可选: 逗号分隔的文件名/glob 白名单, 仅处理匹配文件
const dryRun = argv.includes("--dry-run"); // 仅统计并打印将改动的文件, 不写入磁盘
const { map } = JSON.parse(readFileSync(mapPath, "utf8"));
const EXT = /\.(ts|tsx|js|mjs|cjs|json|yaml|yml|md|rc|toml|html|css|svg|sh|txt)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache", ".next"]);
// 需要整体跳过其子树的顶层目录(在 cwd 下相对路径的首段)。
const SKIP_ROOTS = new Set(["plan"]);
// 本脚本所在目录的绝对路径: 防止对脚本自身(rename-map.json / verify-rename.mjs / rename.mjs)做重写,
// 避免映射真源被破坏。plan/ 也排除在重命名范围外。
const CODETOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
// 仅当 --include-only 提供时: 文件名必须匹配其中任一项(支持子串/glob)。空 = 不过滤全部。
const INCLUDE_ONLY = includeOnly ? includeOnly.split(",").map((s) => s.trim()).filter(Boolean) : [];
const matches = (name) => INCLUDE_ONLY.length === 0 || INCLUDE_ONLY.some((s) => name.includes(s) || (s.includes("*") && new RegExp(s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).test(name)));

let changedFiles = 0;
let changedBytes = 0;

function walk(base) {
  for (const name of readdirSync(base)) {
    if (SKIP_DIRS.has(name) || name === "pnpm-lock.yaml") continue;
    const p = join(base, name);
    const abs = resolve(p);
    // 跳过本工具自身目录及其它保留子树(plan/)下的任何文件, 防止破坏映射真源。
    if (abs.startsWith(CODETOOL_DIR + "/") || SKIP_ROOTS.has(name)) continue;
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!EXT.test(name)) continue;
    if (!matches(name)) continue;
    let src = readFileSync(p, "utf8");
    if (!/openwork/i.test(src)) continue;
    let out = src;
    for (const [from, to] of Object.entries(map)) {
      if (from === to) continue;
      out = out.split(from).join(to);
    }
    if (out !== src) {
      changedFiles++;
      changedBytes += out.length - src.length;
      if (dryRun) {
        console.log(`[dry-run] 将改动: ${p}`);
        continue;
      }
      writeFileSync(p, out);
    }
  }
}

walk(join(root, dir));
const mode = dryRun ? "dry-run" : "done";
console.log(`改名${mode === "dry-run" ? "(试运行, 未写入)" : "完成"}: ${changedFiles} 文件, 净字节变化 ${changedBytes}`);