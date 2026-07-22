import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("admin-scale-performance");
const BENCHMARK_USERS = 50_000;
const BENCHMARK_ORGANIZATIONS = 60_000;
const INITIAL_BUDGET_MS = 500;
const SEARCH_BUDGET_MS = 300;
const BENCHMARK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const validationStartedAt = Date.now();
const execFileAsync = promisify(execFile);

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function resultByName(results, name) {
  return results.find((entry) => entry?.name === name);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

async function currentGitCommitSha() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return String(stdout).trim();
}

function validateBenchmarkFreshness(parsed, currentCommitSha, nowMs) {
  if (parsed?.gitCommitSha !== currentCommitSha) {
    return { ok: false, message: `Benchmark commit ${JSON.stringify(parsed?.gitCommitSha)} does not match current HEAD ${currentCommitSha}` };
  }

  if (parsed?.gitDirty !== false) {
    return { ok: false, message: `Benchmark artifact was not generated from a clean git tree: gitDirty=${JSON.stringify(parsed?.gitDirty)}` };
  }

  if (typeof parsed?.generatedAt !== "string") {
    return { ok: false, message: `Benchmark generatedAt timestamp missing or invalid: ${JSON.stringify(parsed?.generatedAt)}` };
  }

  const generatedAtMs = Date.parse(parsed.generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    return { ok: false, message: `Benchmark generatedAt timestamp is not parseable: ${JSON.stringify(parsed.generatedAt)}` };
  }

  const ageMs = nowMs - generatedAtMs;
  if (ageMs < 0 || ageMs > BENCHMARK_MAX_AGE_MS) {
    const ageMinutes = Math.round(ageMs / 6000) / 10;
    return { ok: false, message: `Benchmark artifact is not fresh for this validation run: generatedAt=${parsed.generatedAt}, ageMinutes=${ageMinutes}` };
  }

  return { ok: true };
}

function validateBenchmark(parsed, currentCommitSha, nowMs) {
  const freshness = validateBenchmarkFreshness(parsed, currentCommitSha, nowMs);
  if (!freshness.ok) {
    return freshness;
  }

  if (parsed?.users !== BENCHMARK_USERS || parsed?.organizations !== BENCHMARK_ORGANIZATIONS || !Array.isArray(parsed.results)) {
    return { ok: false, message: `Benchmark counts/results missing or wrong: ${JSON.stringify(parsed)}` };
  }

  const initial = resultByName(parsed.results, "initial");
  const userSearch = resultByName(parsed.results, "user-search");
  const organizationSearch = resultByName(parsed.results, "organization-search");
  if (!initial || !userSearch || !organizationSearch) {
    return { ok: false, message: `Benchmark result names missing: ${JSON.stringify(parsed.results)}` };
  }

  if (!finiteNumber(initial.durationMs) || initial.durationMs > INITIAL_BUDGET_MS || initial.rows < 1 || initial.rows > 50 || initial.total !== BENCHMARK_USERS || initial.organizationTotal !== BENCHMARK_ORGANIZATIONS) {
    return { ok: false, message: `Initial benchmark failed contract: ${JSON.stringify(initial)}` };
  }
  if (!finiteNumber(userSearch.durationMs) || userSearch.durationMs > SEARCH_BUDGET_MS || userSearch.rows !== 1 || userSearch.total !== 1) {
    return { ok: false, message: `User search benchmark failed contract: ${JSON.stringify(userSearch)}` };
  }
  if (!finiteNumber(organizationSearch.durationMs) || organizationSearch.durationMs > SEARCH_BUDGET_MS || organizationSearch.rows !== 1 || organizationSearch.total !== 1) {
    return { ok: false, message: `Organization search benchmark failed contract: ${JSON.stringify(organizationSearch)}` };
  }

  return { ok: true, results: [initial, userSearch, organizationSearch] };
}

function benchmarkText(result) {
  if (!result.ok) {
    return result.message;
  }

  return result.results.map((row) => {
    const organizations = row.organizationTotal === undefined ? "" : `, organizations=${row.organizationTotal}`;
    return `${row.name}: ${row.durationMs} ms, rows=${row.rows}, total=${row.total}${organizations}`;
  }).join("; ");
}

async function loadBenchmarkResult() {
  let currentCommitSha;
  try {
    currentCommitSha = await currentGitCommitSha();
  } catch (error) {
    return { ok: false, message: `Unable to read current git HEAD for benchmark validation. ${errorMessage(error)}` };
  }

  try {
    const value = await readFile(new URL("../results/admin-scale-performance-benchmark/latest.json", import.meta.url), "utf8");
    return validateBenchmark(JSON.parse(value), currentCommitSha, validationStartedAt);
  } catch (error) {
    return { ok: false, message: `No valid local MySQL benchmark result file found; run pnpm benchmark:admin-scale:mysql. ${errorMessage(error)}` };
  }
}

const benchmarkResult = await loadBenchmarkResult();
const benchmarkResultText = benchmarkText(benchmarkResult);

const ADMIN_URL = process.env.DEN_ADMIN_EVAL_URL || "http://127.0.0.1:3005/admin?adminScaleFixture=1&adminClearCache=1";
const USER_SEARCH_INPUT = 'input[placeholder="Email, name, user id, provider, organization"]';
const ORG_SEARCH_INPUT = 'input[placeholder="Org name, slug, or id"]';
const USER_ROW_SELECTOR = '[data-testid^="admin-user-row-"]';
const ORG_ROW_SELECTOR = '[data-testid^="admin-org-row-"]';
const SCALE_STATUS_SELECTOR = '[data-testid="admin-scale-eval-status"]';
const FIRST_ORG_ROW_SELECTOR = '[data-testid="admin-org-row-organization-0"]';
const TARGET_ORG_ROW_SELECTOR = '[data-testid="admin-org-row-scale-performance-target"]';

async function waitForViewportStable(ctx) {
  await ctx.eval("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", { awaitPromise: true });
}

async function scrollIntoViewport(ctx, selector, block = "center") {
  const scrolled = await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView({ block: ${JSON.stringify(block)}, inline: "nearest" });
    return true;
  })()`);
  ctx.assert(scrolled === true, `Expected to scroll ${selector} into view`);
  await waitForViewportStable(ctx);
}

async function setPageZoom(ctx, value) {
  await ctx.eval(`document.body.style.zoom = ${JSON.stringify(value)}`);
  await waitForViewportStable(ctx);
}

function visibleRowCount(selector) {
  return `document.querySelectorAll(${JSON.stringify(selector)}).length`;
}

function visibleRowIds(selector) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)}), (entry) => entry.getAttribute("data-testid") ?? "")`;
}

function browserUsableMetric() {
  return `(() => {
    const match = document.body.innerText.match(/Browser usable (\\d+) ms/);
    return match ? Number(match[1]) : null;
  })()`;
}

function pageMetric(scope) {
  return `(() => {
    const scope = ${JSON.stringify(scope)};
    const text = document.body.innerText;
    const line = text.split("\\n").find((entry) => entry.includes(scope));
    const match = line?.match(/page (\\d+)-(\\d+) of (\\d+).*?(server|fixture computation) (\\d+) ms/);
    const browserMatch = line?.match(/browser visible (\\d+) ms/);
    return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]), durationLabel: match[4], durationMs: Number(match[5]), browserMs: browserMatch ? Number(browserMatch[1]) : null } : null;
  })()`;
}

function pageMetricHasBrowserMs(scope, total) {
  return `(() => {
    const metric = ${pageMetric(scope)};
    return metric !== null && metric.total === ${total} && metric.browserMs !== null;
  })()`;
}

export default {
  id: "admin-scale-performance",
  title: "Admin stays bounded and searchable at 50k users / 60k organizations",
  kind: "user-facing",
  preserveTheme: true,
  steps: [
    {
      name: "Open admin with scale totals",
      run: async (ctx) => {
        await ctx.prove("Admin opens with exact scale totals and a bounded first user page", {
          voiceover: vo[0],
          action: async () => {
            ctx.state = ctx.state ?? {};
            ctx.state.initialStartedAt = Date.now();
            await ctx.eval(`window.location.href = ${JSON.stringify(ADMIN_URL)}`);
            await ctx.waitForText("Users (50000)", { timeoutMs: 30_000 });
            await ctx.waitForText("Organizations (60000)", { timeoutMs: 30_000 });
            await ctx.waitFor(
              `${browserUsableMetric()} !== null`,
              { timeoutMs: 30_000, label: "browser usable measurement" },
            );
          },
          assert: async () => {
            ctx.state.initialElapsedMs = Date.now() - ctx.state.initialStartedAt;
            await ctx.expectText("Users (50000)");
            await ctx.expectText("Organizations (60000)");
            const browserUsableMs = await ctx.eval(browserUsableMetric());
            const metric = await ctx.eval(pageMetric("Search across all 50000 users"));
            ctx.assert(finiteNumber(browserUsableMs) && browserUsableMs <= INITIAL_BUDGET_MS, `Browser usable took ${browserUsableMs} ms (runner navigation diagnostic ${ctx.state.initialElapsedMs} ms)`);
            ctx.assert(metric?.end === 50 && metric.total === 50000, `Unexpected initial user page metric: ${JSON.stringify(metric)}`);
            await scrollIntoViewport(ctx, USER_SEARCH_INPUT);
          },
          screenshot: { name: "admin-scale-initial", requireText: ["Users (50000)", "Organizations (60000)", "page 1-50 of 50000", "Browser usable"] },
        });
      },
    },
    {
      name: "First page stays bounded",
      run: async (ctx) => {
        await ctx.prove("The page renders only the current bounded user page", {
          voiceover: vo[1],
          action: async () => {
            const initialRowIds = await ctx.eval(visibleRowIds(USER_ROW_SELECTOR));
            ctx.assert(Array.isArray(initialRowIds) && initialRowIds.length > 0, `Expected initial user rows before pagination, got ${JSON.stringify(initialRowIds)}`);
            ctx.state.boundedUserPageInitialRowIds = initialRowIds;
            await ctx.clickText("Next", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText("page 51-100 of 50000", { timeoutMs: 30_000 });
            await ctx.waitFor(`(() => {
              const before = new Set(${JSON.stringify(initialRowIds)});
              const rows = Array.from(document.querySelectorAll(${JSON.stringify(USER_ROW_SELECTOR)}), (entry) => entry.getAttribute("data-testid") ?? "");
              return rows.length > 0 && rows.length <= 50 && rows.some((id) => !before.has(id));
            })()`, { timeoutMs: 30_000, label: "second user page rows" });
          },
          assert: async () => {
            const rowCount = await ctx.eval(visibleRowCount(USER_ROW_SELECTOR));
            const rowIds = await ctx.eval(visibleRowIds(USER_ROW_SELECTOR));
            const metric = await ctx.eval(pageMetric("Search across all 50000 users"));
            ctx.assert(rowCount === 50, `Expected exactly 50 visible user rows (bounded <=50), got ${rowCount}`);
            ctx.assert(metric?.start === 51 && metric.end === 100 && metric.total === 50000, `Unexpected second user page metric: ${JSON.stringify(metric)}`);
            ctx.assert(Array.isArray(rowIds) && rowIds.some((id) => !ctx.state.boundedUserPageInitialRowIds.includes(id)), `Expected second-page user rows to differ from the first page, got ${JSON.stringify(rowIds)}`);
            await ctx.expectText("page 51-100 of 50000");
            await ctx.expectText("first pages capped at 50");
          },
          screenshot: { name: "admin-scale-bounded-users", requireText: ["page 51-100 of 50000", "User 50", "first pages capped at 50", "Export current page CSV"] },
        });
      },
    },
    {
      name: "Search users server-side",
      run: async (ctx) => {
        await ctx.prove("User search finds a result outside the first page within the search budget", {
          voiceover: vo[2],
          action: async () => {
            ctx.state.userSearchStartedAt = Date.now();
            await ctx.fill(USER_SEARCH_INPUT, "scale-search-target@example.com");
            await ctx.waitForText("scale-search-target@example.com", { timeoutMs: 30_000 });
            await ctx.waitFor(pageMetricHasBrowserMs("Search across all 50000 users", 1), { timeoutMs: 30_000, label: "user browser-visible measurement" });
          },
          assert: async () => {
            ctx.state.userSearchElapsedMs = Date.now() - ctx.state.userSearchStartedAt;
            await ctx.expectText("scale-search-target@example.com");
            const rowCount = await ctx.eval(visibleRowCount(USER_ROW_SELECTOR));
            const metric = await ctx.eval(pageMetric("Search across all 50000 users"));
            ctx.assert(rowCount === 1, `Expected one user search row, got ${rowCount}`);
            ctx.assert(metric?.total === 1 && finiteNumber(metric.browserMs) && metric.browserMs <= SEARCH_BUDGET_MS, `Unexpected user search metric: ${JSON.stringify(metric)} (runner input diagnostic ${ctx.state.userSearchElapsedMs} ms)`);
          },
          screenshot: { name: "admin-scale-user-search", requireText: ["scale-search-target@example.com", "browser visible"] },
        });
      },
    },
    {
      name: "Open organizations lazily",
      run: async (ctx) => {
        await ctx.prove("Organizations load only when selected, with exact totals and one bounded page", {
          voiceover: vo[3],
          action: async () => {
            ctx.state.orgOpenStartedAt = Date.now();
            await ctx.clickText("Organizations (60000)");
            await ctx.waitForText("Organization 0", { timeoutMs: 30_000 });
            await ctx.waitFor(pageMetricHasBrowserMs("Search across all 60000 organizations", 60000), { timeoutMs: 30_000, label: "organization first-page browser-visible measurement" });
          },
          assert: async () => {
            ctx.state.orgOpenElapsedMs = Date.now() - ctx.state.orgOpenStartedAt;
            const rowCount = await ctx.eval(visibleRowCount(ORG_ROW_SELECTOR));
            const metric = await ctx.eval(pageMetric("Search across all 60000 organizations"));
            ctx.assert(rowCount > 0 && rowCount <= 50, `Expected at most 50 organization rows, got ${rowCount}`);
            ctx.assert(metric?.end === 50 && metric.total === 60000 && finiteNumber(metric.browserMs) && metric.browserMs <= SEARCH_BUDGET_MS, `Unexpected organization page metric: ${JSON.stringify(metric)} (runner tab diagnostic ${ctx.state.orgOpenElapsedMs} ms)`);
            await setPageZoom(ctx, "0.7");
            await scrollIntoViewport(ctx, FIRST_ORG_ROW_SELECTOR, "start");
          },
          screenshot: { name: "admin-scale-organizations", requireText: ["Organizations (60000)", "page 1-50 of 60000", "Organization 0", "browser visible"] },
        });
      },
    },
    {
      name: "Search organizations server-side",
      run: async (ctx) => {
        await ctx.prove("Organization search finds the global match with controls still available", {
          voiceover: vo[4],
          action: async () => {
            ctx.state.orgSearchStartedAt = Date.now();
            await ctx.fill(ORG_SEARCH_INPUT, "scale-performance-target");
            await ctx.waitForText("Scale Performance Target Organization", { timeoutMs: 30_000 });
            await ctx.waitFor(pageMetricHasBrowserMs("Search across all 60000 organizations", 1), { timeoutMs: 30_000, label: "organization browser-visible measurement" });
          },
          assert: async () => {
            ctx.state.orgSearchElapsedMs = Date.now() - ctx.state.orgSearchStartedAt;
            await ctx.expectText("Scale Performance Target Organization");
            await ctx.expectText("Install links");
            await ctx.expectText("Save access");
            const rowCount = await ctx.eval(visibleRowCount(ORG_ROW_SELECTOR));
            const metric = await ctx.eval(pageMetric("Search across all 60000 organizations"));
            ctx.assert(rowCount === 1, `Expected one organization search row, got ${rowCount}`);
            ctx.assert(metric?.total === 1 && finiteNumber(metric.browserMs) && metric.browserMs <= SEARCH_BUDGET_MS, `Unexpected organization search metric: ${JSON.stringify(metric)} (runner input diagnostic ${ctx.state.orgSearchElapsedMs} ms)`);
            await setPageZoom(ctx, "0.7");
            await scrollIntoViewport(ctx, TARGET_ORG_ROW_SELECTOR, "start");
          },
          screenshot: { name: "admin-scale-org-search", requireText: ["Scale Performance Target Organization", "Install links", "Save access", "browser visible"] },
        });
      },
    },
    {
      name: "Show automated budget evidence",
      run: async (ctx) => {
        await ctx.prove("The visible eval status points reviewers to the automated large-dataset budget test", {
          voiceover: vo[5],
          action: async () => {
            await ctx.eval(`(() => {
              const panel = document.querySelector('[data-testid="admin-scale-eval-status"]');
              if (!panel) return false;
              const result = document.createElement('p');
              result.textContent = ${JSON.stringify(`Latest MySQL benchmark: ${benchmarkResultText}`)};
              panel.appendChild(result);
              return true;
            })()`);
          },
          assert: async () => {
            ctx.assert(benchmarkResult.ok, benchmarkResult.message);
            await ctx.expectText("pnpm benchmark:admin-scale:mysql");
            await ctx.expectText("500 ms initial");
            await ctx.expectText("300 ms searches");
            await setPageZoom(ctx, "1");
            await scrollIntoViewport(ctx, SCALE_STATUS_SELECTOR);
          },
          screenshot: { name: "admin-scale-budget-evidence", requireText: ["pnpm benchmark:admin-scale:mysql", "500 ms initial", "300 ms searches", "Latest MySQL benchmark"] },
        });
      },
    },
  ],
};
