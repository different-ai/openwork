/**
 * Clean, identity-free desktop snapshots for the workshop fast path: build one
 * prepared desktop, prove it holds no login, profile or provider key, stop it,
 * save its disk as a Daytona snapshot, and clone attendees from that snapshot.
 */
import type { DaytonaExec, DaytonaExecResult } from "../../evals/packages/hosts/src/daytona.ts";
import { DaytonaApi } from "../../packages/daytona-evidence/src/api.ts";
import type { Snapshot } from "../../packages/daytona-evidence/src/api.ts";

export const WORKSHOP_SNAPSHOT_PREFIX = "workshop-desktop-";

/** workshop-desktop-<shortsha>-<yyyymmdd>[-<suffix>] */
export function workshopSnapshotName(sha: string, date: Date, suffix = ""): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Workshop snapshots are named from a full pushed commit SHA.");
  if (suffix && !/^[a-z0-9]{1,12}$/.test(suffix)) throw new Error("Workshop snapshot suffix must be 1-12 lowercase letters or digits.");
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${WORKSHOP_SNAPSHOT_PREFIX}${sha.slice(0, 7)}-${day}${suffix ? `-${suffix}` : ""}`;
}

const APP_PROCESSES = ["[e]lectron", "[c]hromium", "[c]hrome", "[o]pencode", "[o]penwork-server", "[v]ite", "[d]ev:ui", "[d]ev:electron", "[h]ttp.server 18099"];

/**
 * Stop every app/browser process the provisioning gates left running and remove
 * throwaway profiles. Caches that make a cold start fast (pnpm store,
 * node_modules/.vite, opencode package cache) stay.
 */
export function stopWorkshopAppsScript(): string {
  return `set -u
for pattern in ${APP_PROCESSES.map((pattern) => `"${pattern}"`).join(" ")}; do pkill -TERM -f "$pattern" >/dev/null 2>&1 || true; done
sleep 3
for pattern in ${APP_PROCESSES.map((pattern) => `"${pattern}"`).join(" ")}; do pkill -KILL -f "$pattern" >/dev/null 2>&1 || true; done
rm -rf /workspace/.openwork-daytona/profiles /tmp/warmup-profile /tmp/openwork-* /tmp/daytona-chrome-* /tmp/xdgtest.log \\
  "$HOME/.config/chromium" "$HOME/.config/google-chrome" "$HOME/.cache/chromium" "$HOME/.cache/google-chrome" \\
  "$HOME/.local/share/opencode/auth.json" "$HOME/.local/share/opencode/mcp-auth.json" 2>/dev/null || true
mkdir -p /home/daytona/workshop/browser
find /home/daytona/workshop/browser -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
echo STOPPED
`;
}

/**
 * Read-only audit. Prints one FINDING line per problem (paths and variable
 * NAMES only, never values) and AUDIT_OK when the disk is safe to share.
 */
export function cleanBaseAuditScript(): string {
  const roots = "/home /root /tmp /var/tmp /workspace/.openwork-daytona";
  // Public, content-addressed registry caches (pnpm store/metadata, npm _cacache) hold npm package bytes, not user data.
  const prune = "\\( -name node_modules -o -name pnpm -o -name _cacache -o -name pnpm-store -o -name .git -o -path /proc \\) -prune -o";
  return `set -u
fail=0
finding() { printf "FINDING %s\\n" "$1"; fail=1; }
[ -e /daytona-secrets ] && finding "secrets-volume:/daytona-secrets"
if [ -d /home/daytona/workshop/browser ] && [ -n "$(ls -A /home/daytona/workshop/browser 2>/dev/null)" ]; then finding "workshop-browser-profile-not-empty"; fi
[ -f /home/daytona/workshop/workspace/opencode.json ] || finding "workshop-workspace-missing"
# Clones re-run the clean-source gate of provisionDesktopSandbox; an untracked build file would refuse every clone.
while IFS= read -r path; do [ -n "$path" ] && finding "workspace-dirty:$path"; done <<EOF
$(cd /workspace && git status --porcelain=v1 --untracked-files=all -- . ":(exclude).openwork-daytona" ":(exclude).openwork-daytona/**" 2>&1 | head -20)
EOF
while IFS= read -r path; do [ -n "$path" ] && finding "browser-or-electron-profile-state:$path"; done <<EOF
$(find ${roots} ${prune} \\( -name Cookies -o -name "Login Data" -o -name "Local Storage" -o -name "Session Storage" -o -name IndexedDB -o -name "Web Data" \\) -print 2>/dev/null)
EOF
while IFS= read -r path; do [ -n "$path" ] && finding "credential-file:$path"; done <<EOF
$(find ${roots} ${prune} -type f \\( -name auth.json -o -name mcp-auth.json -o -name .netrc -o -name .git-credentials -o -name "*.pem" -o -name "*.key" -o -name ".env" -o -name "*.env" \\) -print 2>/dev/null)
EOF
while IFS= read -r path; do [ -n "$path" ] && finding "provider-key-pattern:$path"; done <<EOF
$(grep -rIlE "sk-(proj-|ant-)?[A-Za-z0-9_-]{24,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36}|xox[bpas]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{36}|dtn_[A-Za-z0-9]{32,}" ${roots} --exclude-dir=node_modules --exclude-dir=pnpm-store --exclude-dir=pnpm --exclude-dir=_cacache --exclude-dir=.git --exclude-dir=.vite 2>/dev/null)
EOF
while IFS= read -r name; do [ -n "$name" ] && finding "secret-env-name:$name"; done <<EOF
$(env | cut -d= -f1 | grep -E "^(OPENAI|ANTHROPIC|OPENROUTER|GEMINI|GOOGLE_API|GROQ|MISTRAL|XAI|DEEPSEEK|TOGETHER|FIREWORKS|AWS_SECRET|AWS_SESSION|DAYTONA_API_KEY|GITHUB_TOKEN|GH_TOKEN|OPENWORK_.*TOKEN|DEN_.*SECRET|BETTER_AUTH_SECRET)" )
EOF
while IFS= read -r line; do [ -n "$line" ] && finding "running-app-process:$line"; done <<EOF
$(pgrep -af "${APP_PROCESSES.slice(0, 7).join("|")}" 2>/dev/null | grep -v pgrep | cut -c1-120)
EOF
if [ "$fail" = 0 ]; then echo AUDIT_OK; fi
`;
}

export interface CleanBaseAudit { ok: boolean; findings: string[] }
export function parseCleanBaseAudit(stdout: string): CleanBaseAudit {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const findings = lines.filter((line) => line.startsWith("FINDING ")).map((line) => line.slice("FINDING ".length));
  return { ok: findings.length === 0 && lines.includes("AUDIT_OK"), findings };
}

/**
 * `daytona snapshot list -f json` returns one 100-item page, so a newly saved
 * snapshot can be invisible to provisionDesktopSandbox's snapshot gate in a
 * busy organization. This exec wrapper serves that one call from every page.
 */
export function pagedSnapshotListExec(exec: DaytonaExec, maxPages = 20): DaytonaExec {
  return async (args, opts) => {
    if (args.length !== 4 || args[0] !== "snapshot" || args[1] !== "list" || args[2] !== "-f" || args[3] !== "json") return exec(args, opts);
    const all: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const result: DaytonaExecResult = await exec(["snapshot", "list", "-f", "json", "--page", String(page), "--limit", "100"], opts);
      if (result.code !== 0) return result;
      const parsed: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) return result;
      all.push(...parsed);
      if (parsed.length < 100) return { ...result, stdout: JSON.stringify(all) };
    }
    throw new Error(`Snapshot listing exceeded ${maxPages} pages.`);
  };
}

/** Run at most `limit` tasks at once; every item settles, results keep input order. */
export async function settledPool<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer.");
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      const item = items[index] as T;
      try { results[index] = { status: "fulfilled", value: await run(item, index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** provisionDesktopSandbox logs `==> <gate> done (<ms>ms)`; keep seconds per gate. */
export function parseProvisionSteps(lines: readonly string[]): Record<string, number> {
  const steps: Record<string, number> = {};
  for (const line of lines) {
    const match = /^==> (.+) (?:done|failed) \((\d+)ms\)$/.exec(line.trim());
    if (match?.[1] && match[2]) steps[match[1]] = Math.round(Number(match[2]) / 100) / 10;
  }
  return steps;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface SavedSnapshot { name: string; id: string; state: string; stopSeconds: number; snapshotSeconds: number }

/** Stop the sandbox, save its disk (no memory) as `name`, and wait for `active`. */
export async function saveSandboxSnapshot(api: DaytonaApi, sandboxId: string, name: string, log: (line: string) => void = () => {}): Promise<SavedSnapshot> {
  if (!name.startsWith(WORKSHOP_SNAPSHOT_PREFIX)) throw new Error("Refusing to save a non-workshop snapshot name.");
  if (await api.getSnapshot(name)) throw new Error(`Snapshot ${name} already exists; choose a new suffix.`);
  const stopStarted = Date.now();
  const before = await api.getSandbox(sandboxId);
  if (!before) throw new Error("Base sandbox disappeared before snapshot.");
  if (before.state !== "stopped") {
    await api.stopSandbox(sandboxId);
    await api.waitForSandbox(sandboxId, ["stopped"], 5 * 60_000);
  }
  const stopSeconds = Math.round((Date.now() - stopStarted) / 1000);
  log(`base stopped in ${stopSeconds}s; saving snapshot ${name}`);
  const snapStarted = Date.now();
  await api.snapshotSandbox(sandboxId, name, false);
  const saved: Snapshot = await api.waitForSnapshot(name, 30 * 60_000);
  return { name, id: saved.id, state: saved.state, stopSeconds, snapshotSeconds: Math.round((Date.now() - snapStarted) / 1000) };
}

export { DaytonaApi };
