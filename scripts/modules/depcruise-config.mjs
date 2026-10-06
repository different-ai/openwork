// Shared dependency-cruiser configuration for the Den module boundaries (W0-08).
// Used by the repo config (.dependency-cruiser.mjs) and the self-test config.
import { buildModuleRules, escapeRegex, moduleRoots, sharedPackages } from "./rules.mjs";

// What `pnpm boundaries:*` cruises. Keep in sync with includeOnly below and tsconfig.depcruise.json.
export const CRUISE_ROOTS = [
  "ee/apps/den-api/src",
  "ee/apps/den-web/app",
  "ee/apps/den-web/components",
  "ee/packages/den-db/src",
  ...sharedPackages().map((pkg) => pkg.cruiseRoot),
];

/**
 * @param {{ graph: Parameters<typeof buildModuleRules>[0]["graph"],
 *           enforced: { core: boolean, modules: string[] },
 *           prefix?: string,
 *           tsConfig: string }} input
 */
export function createDepcruiseConfig({ graph, enforced, prefix = "", tsConfig }) {
  const roots = moduleRoots(prefix);
  const shared = sharedPackages(prefix);
  const p = escapeRegex(prefix);
  return {
    forbidden: buildModuleRules({ graph, enforced, roots, shared }),
    options: {
      includeOnly: [
        `^${p}(?:ee/apps/den-api/src|ee/apps/den-web/(?:app|components)|ee/packages/den-db/src)/`,
        ...shared.map((pkg) => pkg.path),
      ],
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
