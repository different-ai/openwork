import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { briefTest, claim, testBrief } from "@openwork/testkit";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const requireFromRepo = createRequire(import.meta.url);

const vercelApps = ["apps/app", "ee/apps/den-web", "ee/apps/diagnostics", "ee/apps/landing"];

// Exit 0 skips the build; anything else (affected, missing base ref, git or
// turbo failure) must exit 1 so Vercel builds instead of erroring the deployment.
function ignoreCommandFor(packageName: string): string {
  return `turbo query affected --base=$VERCEL_GIT_PREVIOUS_SHA --packages ${packageName} --exit-code || exit 1`;
}

type DenApiRedirectRules = {
  denApiRedirects: (env: Record<string, string | undefined>) => Array<{
    source: string;
    destination: string;
    permanent: boolean;
  }>;
};

briefTest(testBrief({
  behavior: "Vercel builds only the apps a commit affects, and hosted /api/den callers are redirected without invoking a function.",
  claims: {
    skipUnaffectedBuilds: claim("every Vercel-deployed app gates its build on turbo's affected graph for its own package", {
      never: "gate it on another package's changes, error the deployment when the query cannot run, or strip .git from the build checkout",
    }),
    routingLayerRedirect: claim("Den Web emits the /api/den 307 as a build-time redirect once the API origin is configured", {
      never: "emit a redirect rule when the API origin is only known per request, or drop the per-request fallback route",
    }),
  },
}), async ({ prove }) => {
  for (const app of vercelApps) {
    const config: { ignoreCommand?: string } = JSON.parse(await readFile(join(repoRoot, app, "vercel.json"), "utf8"));
    const manifest: { name: string; scripts?: Record<string, string> } = JSON.parse(
      await readFile(join(repoRoot, app, "package.json"), "utf8"),
    );
    expect(config.ignoreCommand, `${app}/vercel.json`).toBe(ignoreCommandFor(manifest.name));
    expect(manifest.scripts?.build, `${app} needs a build task for turbo's affected graph`).toBeTruthy();
  }

  const vercelIgnore = (await readFile(join(repoRoot, ".vercelignore"), "utf8")).split("\n").map((line) => line.trim());
  expect(vercelIgnore, ".vercelignore must keep .git so the affected query can read history").not.toContain(".git");

  prove.skipUnaffectedBuilds(
    true,
    `${vercelApps.length} Vercel projects run turbo query affected for their own workspace package before installing, failing open to a build`,
  );

  const { denApiRedirects }: DenApiRedirectRules = requireFromRepo(
    join(repoRoot, "ee", "apps", "den-web", "next-config-den-api-redirects.cjs"),
  );

  expect(denApiRedirects({})).toEqual([]);
  expect(denApiRedirects({ DEN_API_BASE: "https://api.openworklabs.com", DEN_BASE_URL: "https://app.openworklabs.com" })).toEqual([
    { source: "/api/den/:path*", destination: "https://api.openworklabs.com/:path*", permanent: false },
  ]);
  expect(denApiRedirects({ DEN_BASE_URL: "https://app.openworklabs.com" })).toEqual([
    { source: "/api/den/:path*", destination: "https://api.app.openworklabs.com/:path*", permanent: false },
  ]);

  const nextConfig = await readFile(join(repoRoot, "ee", "apps", "den-web", "next.config.js"), "utf8");
  expect(nextConfig).toContain("return denApiRedirects(process.env);");
  await access(join(repoRoot, "ee", "apps", "den-web", "app", "api", "den", "[...path]", "route.ts"));

  prove.routingLayerRedirect(
    true,
    "next.config.js emits one temporary /api/den/:path* redirect only when DEN_API_BASE or DEN_BASE_URL is set; the route handler remains for per-request resolution",
  );
});
