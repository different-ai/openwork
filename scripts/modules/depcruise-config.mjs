// Shared dependency-cruiser configuration for the Den module boundaries (W0-08).
// Used by the repo config (.dependency-cruiser.mjs) and the self-test config.
import { buildModuleRules, escapeRegex, moduleRoots } from "./rules.mjs";

// What `pnpm boundaries:*` cruises. Keep in sync with includeOnly below and tsconfig.depcruise.json.
export const CRUISE_ROOTS = ["ee/apps/den-api/src", "ee/apps/den-web/app", "ee/apps/den-web/components", "ee/packages/den-db/src"];

/**
 * @param {{ graph: Parameters<typeof buildModuleRules>[0]["graph"],
 *           enforced: { core: boolean, modules: string[] },
 *           prefix?: string,
 *           tsConfig: string }} input
 */
export function createDepcruiseConfig({ graph, enforced, prefix = "", tsConfig }) {
  const roots = moduleRoots(prefix);
  const p = escapeRegex(prefix);
  return {
    forbidden: buildModuleRules({ graph, enforced, roots }),
    options: {
      includeOnly: `^${p}(?:ee/apps/den-api/src|ee/apps/den-web/(?:app|components)|ee/packages/den-db/src)/`,
      exclude: { path: "(?:\\.next|dist|generated)/" },
      doNotFollow: { path: "node_modules" },
      tsPreCompilationDeps: true,
      tsConfig: { fileName: tsConfig },
      enhancedResolveOptions: {
        exportsFields: ["exports"],
        conditionNames: ["development", "types", "import", "default"],
        extensions: [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"],
      },
      reporterOptions: {
        markdown: { showTitle: true, title: "## Den module boundaries", showRulesSummary: true },
      },
    },
  };
}
