import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { z } from "zod";

const browser = [process.env.OPENWORK_BROWSER_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(path => path && existsSync(path));
const appRoot = resolve(import.meta.dir, "..");
const run = promisify(execFile);

test.skipIf(!browser)("real browser paints distinct checked radios and visible indicator dots in both themes", async () => {
  if (!browser) throw new Error("Set OPENWORK_BROWSER_EXECUTABLE to a Chromium executable");
  const parent = join(tmpdir(), "opencode");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "radio-visual-"));
  try {
    const bundle = await Bun.build({ entrypoints: [join(appRoot, "tests/fixtures/radio-group-visual.tsx")], target: "browser", format: "iife", minify: true });
    if (!bundle.success) throw new AggregateError(bundle.logs, "Radio fixture build failed");
    await writeFile(join(directory, "fixture.js"), await bundle.outputs[0].text());
    const result = await build({ root: appRoot, configFile: false, logLevel: "silent", plugins: [tailwindcss()], build: { write: false, rollupOptions: { input: join(appRoot, "src/app/index.css") } } });
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected a single CSS build");
    const css = result.output.find(item => item.type === "asset" && item.fileName.endsWith(".css"));
    if (!css || css.type !== "asset") throw new Error("Production stylesheet missing");
    await writeFile(join(directory, "fixture.css"), css.source);
    await writeFile(join(directory, "fixture.html"), '<!doctype html><html><head><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
    const { stdout } = await run(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", `--user-data-dir=${join(directory, "profile")}`, "--virtual-time-budget=2000", "--dump-dom", `file://${join(directory, "fixture.html")}`], { timeout: 20_000, maxBuffer: 2_000_000 });
    const match = stdout.match(/<pre id="radio-visual-result">([^<]*)<\/pre>/);
    if (!match) throw new Error("Browser did not report computed radio styles");
    const report = z.object({ failures: z.array(z.string()), samples: z.array(z.object({ theme: z.string(), selected: z.string(), selectedBackground: z.string(), unselectedBackground: z.string(), indicatorWidth: z.number(), indicatorHeight: z.number() })) }).parse(JSON.parse(match[1]));
    expect(report.failures).toEqual([]);
    expect(report.samples).toHaveLength(4);
    for (const sample of report.samples) {
      expect(sample.selectedBackground).not.toBe(sample.unselectedBackground);
      expect(sample.indicatorWidth).toBe(8);
      expect(sample.indicatorHeight).toBe(8);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
