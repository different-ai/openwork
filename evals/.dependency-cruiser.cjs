module.exports = {
  forbidden: [
    // Effect belongs only in the environment layer.
    {
      name: "effect-only-in-env",
      severity: "error",
      from: { pathNot: "^packages/env(?:/|$)" },
      to: { path: "^effect(?:/|$)" },
    },
    // The environment layer must not depend on test frameworks or fixtures.
    {
      name: "env-is-framework-free",
      severity: "error",
      from: { path: "^packages/env(?:/|$)" },
      to: { path: "^(?:vitest|@openwork/(?:test-evidence|testkit))(?:/|$)" },
    },
    // Layers below fixtures must not depend on fixture or test-framework packages.
    {
      name: "layers-below-fixtures",
      severity: "error",
      from: { path: "^packages/(?:behaviors|matchers|cdp|labs|hosts|timeline)(?:/|$)" },
      to: { path: "^(?:vitest|@openwork/(?:testkit|env|test-evidence))(?:/|$)" },
    },
    // Eval primitives stay independent of the shared world shell; env is the
    // single adapter boundary that supplies Den/desktop orchestration.
    {
      name: "world-shell-through-env",
      severity: "error",
      from: { path: "^packages/(?:behaviors|matchers|cdp|labs|hosts|timeline)(?:/|$)" },
      to: { path: "^@openwork/world(?:/|$)" },
    },
    // Reusable packages must not depend on runner implementation modules.
    {
      name: "no-runner-from-packages",
      severity: "error",
      from: { path: "^packages(?:/|$)" },
      to: { path: "^runner(?:/|$)" },
    },
    // Specs use the capability-restricted fixture layer, never implementation rails.
    {
      name: "specs-use-testkit-only",
      severity: "error",
      from: { path: "^(?:specs/.*\\.e2e\\.test\\.ts|\\.\\./scenarios/.*/e2e\\.test\\.ts)$" },
      to: { path: "^@openwork/(?:hosts|cdp|behaviors|test-evidence|labs|env)(?:/|$)" },
    },
    // Imperative worlds stay framework-free and arrange only through lower layers.
    {
      name: "worlds-use-seed-layer",
      severity: "error",
      from: { path: "^worlds(?:/|$)" },
      to: { path: "^(?:vitest|@openwork/(?:testkit|test-evidence))(?:/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".mjs", ".js", ".json"],
    },
  },
};
