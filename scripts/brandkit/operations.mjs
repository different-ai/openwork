// Declarative operation list, built from one discovered brands/<id>/brand.json.
//
// GUIDING RULE: nothing here is committed into an upstream-tracked file. Every
// operation mutates the WORKING TREE at build time and is reverted with
// `--revert` (git checkout). That is what keeps `git pull upstream` a clean
// fast-forward: our committed diff is only additive new files.
//
// Each op targets a verified anchor. When an anchor can't be pinned down yet,
// the op is marked `pending` so it shows up in the report as a to-do rather
// than silently doing nothing (or worse, corrupting a file).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./lib/config.mjs";

const LOCALES_DIR = "apps/app/src/i18n/locales";

/** Escape a string for safe use inside a RegExp source. */
function rx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One brand-name replace op per locale file (auto-covers locales upstream adds). */
function localeBrandOps(brandName) {
  let files = [];
  try {
    files = readdirSync(resolve(REPO_ROOT, LOCALES_DIR)).filter(
      (f) => f.endsWith(".ts") && f !== "index.ts",
    );
  } catch {
    files = ["en.ts"];
  }
  return files.map((file) => ({
    id: `brand-name:${file}`,
    feature: "brandName",
    type: "replaceAll",
    target: `${LOCALES_DIR}/${file}`,
    // Case-sensitive whole word only — deliberately avoids `openwork://`,
    // `@openwork/...`, `openworklabs.com`, and `openwork.defaultModel`.
    pattern: "\\bOpenWork\\b",
    flags: "g",
    replace: brandName,
    signature: brandName,
  }));
}

/**
 * Effective on/off state of each feature group for a loaded config.
 * `features.*` is the distributor's toggle; a group with its own config gate
 * (cloud.hide) must have both switched on to be active.
 */
export function enabledFeatures(config) {
  const f = config.features;
  return {
    brandName: f.brandName,
    accentColor: f.accentColor,
    assets: f.assets,
    desktopIdentity: f.desktopIdentity,
    providers: f.providers,
    welcomeOverride: f.welcomeOverride,
    cloudHide: f.cloudHide && config.cloud.hide,
    // The language variant is only active for a non-English build; an English
    // apply treats the group as off, which cleans up a previous variant's edits.
    language: f.language && config.language.default !== "en",
    trim: f.trim,
  };
}

/**
 * Build the full operation list for a loaded config. Every op carries a
 * `feature` tag; ALL ops are returned regardless of toggles so the caller can
 * both apply enabled groups and clean up disabled ones (see apply.mjs).
 */
export function buildOperations(config) {
  const { brand, desktop, providers, language } = config;
  const a = brand.assets;
  const enabled = enabledFeatures(config);
  // Language-aware brand shown in the UI + window title; `brand.name` stays the
  // ASCII base for appId/scheme/artifact/install-dir/productName.
  const displayName = brand.displayName ?? brand.name;
  // Packaged app / exe / .app filename (electron-builder productName).
  const packagedName = desktop.productName ?? brand.name;
  // Single-language variants (e.g. BRANDKIT_LANG=zh) get a locale-suffixed
  // artifact name so the installer files don't collide with the default build.
  const langSuffix = enabled.language ? `-${language.default}` : "";
  const artifactId = brand.id ?? brand.name.toLowerCase().replace(/[^a-z0-9-]/g, "");

  // Hardcoded-literal translations (brand/i18n/<lang>.ui.json). Built FIRST and
  // placed BEFORE the brand-name ops: their `find` anchors target the pristine
  // upstream text (`{BRAND}` → "OpenWork"), so they hold in --check mode and on
  // a fresh tree; the brand-name replaceAll then catches whatever prose the
  // translations didn't consume. Their `replace` renders the display name.
  const langUiOps = [];
  for (const lang of overlayLangs(language)) {
    const uiPath = resolve(REPO_ROOT, `brand/i18n/${lang}.ui.json`);
    if (!existsSync(uiPath)) continue;
    let uiMap = {};
    try {
      uiMap = JSON.parse(readFileSync(uiPath, "utf8"));
    } catch (error) {
      throw new Error(`invalid JSON in brand/i18n/${lang}.ui.json: ${error.message}`);
    }
    const brandOut = enabled.brandName ? displayName : "OpenWork";
    let i = 0;
    for (const [file, pairs] of Object.entries(uiMap)) {
      for (const [en, translated] of Object.entries(pairs)) {
        // Entries with {BRAND} must anchor on pristine text ("OpenWork", fresh
        // tree / --check) OR already-branded text (displayName, applying zh on
        // top of a previous en apply) — offer both candidates.
        const finds = [...new Set([
          en.replaceAll("{BRAND}", "OpenWork"),
          en.replaceAll("{BRAND}", brandOut),
        ])];
        langUiOps.push({
          id: `lang:ui-${lang}-${i++}`,
          feature: "language",
          type: "replaceString",
          target: file,
          find: finds.length === 1 ? finds[0] : finds,
          replace: translated.replaceAll("{BRAND}", brandOut),
        });
      }
    }
  }

  const ops = [
    ...langUiOps,
    // ---- Brand name (window title, packaged name, UI copy) -----------------
    {
      id: "brand-name:index.html",
      feature: "brandName",
      type: "replaceAll",
      target: "apps/app/index.html",
      pattern: "\\bOpenWork\\b",
      flags: "g",
      replace: displayName,
      signature: displayName,
    },
    {
      id: "brand-name:electron-main",
      feature: "brandName",
      type: "replaceAll",
      target: "apps/desktop/electron/main.mjs",
      pattern: "\\bOpenWork\\b",
      flags: "g",
      replace: displayName,
      signature: displayName,
    },
    {
      id: "brand-name:desktop-distribution",
      feature: "brandName",
      type: "replaceAll",
      target: "apps/desktop/electron/desktop-distribution.mjs",
      pattern: "\\bOpenWork\\b",
      flags: "g",
      replace: displayName,
      signature: displayName,
    },
    // Built-in extension catalog: names/descriptions/setup copy reference
    // "OpenWork" in prose (e.g. "stays visible inside OpenWork"). The `\bOpenWork\b`
    // word boundary already skips the TypeScript type names in this same file
    // (OpenWorkExtensionManifest etc. have no boundary between "OpenWork" and
    // the following word), so only the prose mentions are touched.
    {
      id: "brand-name:extensions-catalog",
      feature: "brandName",
      type: "replaceAll",
      target: "apps/app/src/app/extensions.ts",
      pattern: "\\bOpenWork\\b",
      flags: "g",
      replace: displayName,
      signature: displayName,
    },
    ...localeBrandOps(displayName),

    // ---- Accent color (routes through the existing BrandThemeEffect) -------
    {
      id: "brand-accent",
      feature: "accentColor",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/cloud/brand-theme.tsx",
      find: "const brandAccentColor = config.brandAccentColor;",
      replace: `const brandAccentColor = config.brandAccentColor ?? "${brand.accentColor}"; /* brandkit:accent */`,
    },

    // ---- Brand assets (overwrite in place; paths in code stay the same) ----
    { id: "asset:mark", feature: "assets", type: "overwriteAsset", source: a.mark, target: "apps/app/public/openwork-mark.svg" },
    { id: "asset:logo", feature: "assets", type: "overwriteAsset", source: a.logo, target: "apps/app/public/openwork-logo.svg" },
    { id: "asset:logo-square", feature: "assets", type: "overwriteAsset", source: a.logoSquare, target: "apps/app/public/openwork-logo-square.svg" },
    { id: "asset:favicon-32", feature: "assets", type: "overwriteAsset", source: a.favicon32, target: "apps/app/public/favicon-32x32.png" },
    { id: "asset:favicon-16", feature: "assets", type: "overwriteAsset", source: a.favicon16, target: "apps/app/public/favicon-16x16.png" },
    { id: "asset:apple-touch", feature: "assets", type: "overwriteAsset", source: a.appleTouchIcon, target: "apps/app/public/apple-touch-icon.png" },
    { id: "asset:desktop-png", feature: "assets", type: "overwriteAsset", source: a.desktopIconPng, target: "apps/desktop/resources/icons/icon.png" },
    { id: "asset:desktop-ico", feature: "assets", type: "overwriteAsset", source: a.desktopIconIco, target: "apps/desktop/resources/icons/icon.ico" },
    { id: "asset:desktop-icns", feature: "assets", type: "overwriteAsset", source: a.desktopIconIcns, target: "apps/desktop/resources/icons/icon.icns" },

    // main.mjs resolves process.resourcesPath/icons/icon.png at runtime for the
    // Windows taskbar identity (registerWindowsDisplayShortcut writes the shortcut
    // ico from it); upstream's `files:` never packages resources/, so without this
    // the runtime falls back to app.getFileIcon on the computed Programs path,
    // which yields a corrupt image on parked (non-installed) builds — blank icon.
    {
      id: "pkg:icon-resource",
      feature: "assets",
      type: "injectBefore",
      target: "apps/desktop/electron-builder.base.yml",
      marker: "brandkit:icon-resource",
      anchor: "  - from: ../app/dist",
      block:
        `  # brandkit:icon-resource — ship icon.png for the runtime taskbar identity\r\n` +
        `  - from: resources/icons/icon.png\r\n` +
        `    to: icons/icon.png\r\n`,
    },

    // ---- Packaged app identity (electron-builder.yml) ----------------------
    {
      id: "pkg:appId",
      feature: "desktopIdentity",
      type: "replaceString",
      target: "apps/desktop/electron-builder.yml",
      find: "appId: com.differentai.openwork",
      replace: `appId: ${desktop.appId}`,
    },
    {
      id: "pkg:productName",
      feature: "desktopIdentity",
      type: "replaceString",
      target: "apps/desktop/electron-builder.yml",
      find: "productName: OpenWork",
      replace: `productName: ${packagedName}`,
    },
    // Unsigned distribution: hardened runtime requires a valid Developer ID +
    // notarization, otherwise the ad-hoc-signed app fails to launch ("code
    // signature invalid") even after the user clears quarantine. Turn it off
    // for the no-Apple-account build. REVERT this op when real signing is added.
    {
      id: "pkg:mac-hardened-runtime",
      feature: "desktopIdentity",
      type: "replaceString",
      target: "apps/desktop/electron-builder.base.yml",
      find: "hardenedRuntime: true",
      replace: "hardenedRuntime: false # brandkit: unsigned build (no notarization)",
    },
    {
      id: "pkg:artifactName",
      feature: "desktopIdentity",
      type: "replaceAll",
      target: "apps/desktop/electron-builder.yml",
      // Matches the stock "openwork-" prefix AND any previously-applied brand
      // prefix, so alternating en/zh applies (the langSuffix changes the value
      // between runs) re-pin it instead of stranding the old one. `${os}` etc.
      // are electron-builder template vars — kept literal in the replacement.
      pattern: "artifactName: [a-z0-9-]+-\\$\\{os\\}-\\$\\{arch\\}-\\$\\{version\\}\\.\\$\\{ext\\}",
      flags: "g",
      replace: `artifactName: ${artifactId}${langSuffix}-` + '${os}-${arch}-${version}.${ext}',
    },
    {
      id: "pkg:scheme",
      feature: "desktopIdentity",
      type: "replaceAll",
      target: "apps/desktop/electron-builder.yml",
      // `(?![\w-])` pins to the bare scheme value and skips `- openwork-orchestrator…`.
      // No literal newline in the anchor, so CRLF vs LF can't drift us.
      pattern: "- openwork(?![\\w-])",
      flags: "g",
      replace: `- ${desktop.deepLinkScheme}`,
      signature: `- ${desktop.deepLinkScheme}`,
    },
    {
      id: "runtime:scheme",
      feature: "desktopIdentity",
      type: "replaceAll",
      target: "apps/desktop/electron/desktop-distribution.mjs",
      pattern: rx('protocolScheme: "openwork"'),
      flags: "g",
      replace: `protocolScheme: ${JSON.stringify(desktop.deepLinkScheme)}`,
      signature: `protocolScheme: ${JSON.stringify(desktop.deepLinkScheme)}`,
    },
    // ---- Own data dir: without this the branded app reads/writes the SAME
    // %APPDATA%/com.differentai.openwork state as a stock OpenWork install on
    // the same machine (shared workspaces, auth, server state).
    {
      id: "runtime:app-identifier",
      feature: "desktopIdentity",
      type: "replaceAll",
      target: "apps/desktop/electron/desktop-distribution.mjs",
      pattern: rx('appIdentifier: "com.differentai.openwork"'),
      flags: "g",
      replace: `appIdentifier: ${JSON.stringify(desktop.appId)}`,
      signature: `appIdentifier: ${JSON.stringify(desktop.appId)}`,
    },
    // ---- Own install dir: electron-builder derives the NSIS/appImage install
    // folder from package.json `name` ("@openwork/desktop" → "@openworkdesktop"),
    // NOT productName — so without this the branded installer overwrites a
    // stock OpenWork desktop install in place. extraMetadata only applies at
    // package time; the on-disk package.json (and pnpm --filter) are untouched.
    {
      id: "pkg:install-dir",
      feature: "desktopIdentity",
      type: "injectBefore",
      target: "apps/desktop/electron-builder.base.yml",
      marker: "brandkit:install-dir",
      anchor: "asar: true",
      block:
        `# brandkit:install-dir — own install folder (default derives from package.json name)\r\n` +
        `extraMetadata:\r\n` +
        `  name: ${artifactId}\r\n`,
    },

    // ---- Updater feed: point electron-updater at the brand's own releases --
    // Left on different-ai/openwork, a shipped branded app AUTO-UPDATES ITSELF
    // BACK INTO STOCK OPENWORK as soon as upstream publishes a newer version.
    ...(desktop.updateFeed
      ? [
          {
            id: "pkg:update-feed",
            feature: "desktopIdentity",
            type: "replaceAll",
            target: "apps/desktop/electron-builder.base.yml",
            // EOL-agnostic (\s+) — CI checks out LF, Windows trees are CRLF.
            pattern: "owner: different-ai\\s+    repo: openwork",
            flags: "g",
            replace: `owner: ${desktop.updateFeed.owner}\r\n    repo: ${desktop.updateFeed.repo}`,
            signature: `owner: ${desktop.updateFeed.owner}`,
          },
        ]
      : []),

    // ---- Providers: default model (safe subset) ----------------------------
    {
      id: "providers:opencode-json",
      feature: "providers",
      type: "writeFile",
      target: "opencode.json",
      content: renderOpencodeJson(providers),
    },
    // Repoint the opencode model catalog (OPENCODE_MODELS_URL) at the brand's
    // gateway so the model picker populates from OUR /api.json (curated) instead
    // of the upstream mirror (models.openworklabs.com). Dev mode is left alone.
    ...(providers.modelsCatalogUrl
      ? [
          {
            id: "providers:models-catalog-url",
            feature: "providers",
            type: "replaceString",
            target: "apps/server/src/opencode-models-url.ts",
            find: 'const PRODUCTION_MODELS_URL = "https://models.openworklabs.com/";',
            replace: `const PRODUCTION_MODELS_URL = ${JSON.stringify(providers.modelsCatalogUrl)};`,
          },
        ]
      : []),

    // ---- Reroute: brand-owned welcome page (no source edit to the target) --
    // The override is served in place of the app's welcome-page.tsx via the
    // reroute Vite plugin; the original component is never modified.
    // Generated INSIDE apps/app (not brand/) so react/jsx-runtime and the `@/`
    // alias resolve from apps/app/node_modules in production Rollup builds.
    {
      id: "reroute:welcome-override",
      feature: "welcomeOverride",
      type: "writeFile",
      target: "apps/app/src/brandkit-generated/welcome-page.tsx",
      content: renderWelcomeOverride(config.welcome),
    },
    // Always generated (no feature tag) so `vite --config vite.brandkit.config.mts`
    // keeps working with welcomeOverride off — the reroute map is just empty then.
    {
      id: "reroute:vite-config",
      type: "writeFile",
      target: "apps/app/vite.brandkit.config.mts",
      content: renderBrandViteConfig(enabledFeatures(config).welcomeOverride),
    },
    // Make production builds actually use the brandkit Vite config. Without
    // this the reroute overrides (welcome page, etc.) exist on disk but the
    // packaged renderer is built with plain `vite build` and never sees them.
    {
      id: "reroute:app-build-script",
      type: "replaceString",
      target: "apps/app/package.json",
      find: '"build": "vite build",',
      replace: '"build": "vite build --config vite.brandkit.config.mts",',
    },

    // ---- Hide cloud / Den surfaces ------------------------------------------
    {
      id: "cloud:settings-tabs",
      feature: "cloudHide",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/settings/shell/settings-page.tsx",
      find: [
        "  return memoryEnabled ? [...CLOUD_SETTINGS_TABS, \"memory\"] : CLOUD_SETTINGS_TABS;",
        "  return memoryEnabled ? [\"cloud-account\", \"memory\", \"connect\"] : CLOUD_SETTINGS_TABS;",
        "  return memoryEnabled ? [\"cloud-account\", \"memory\"] : CLOUD_SETTINGS_TABS;",
      ],
      replace: "  return []; /* brandkit:hide-cloud */",
    },
    // Kill the header "Sign in" button, the status-bar sign-in, and the
    // OpenWork Models startup promo in one shot — all gated on cloudSignin.
    {
      id: "cloud:shell-signin",
      feature: "cloudHide",
      type: "replaceString",
      target: "apps/app/src/react-app/shell/shell-config.tsx",
      find: "cloudSignin: true,",
      replace: "cloudSignin: false, /* brandkit:hide-cloud */",
    },
    // Suppress every "OpenWork Models" cloud promo (model picker group, AI
    // settings subscribe/connect rows, status bar, startup dialog) by making
    // the shared gate report the provider as already present.
    {
      id: "cloud:openwork-models-promo",
      feature: "cloudHide",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/cloud/openwork-models-promo.ts",
      find: "return providerIds.some((id) => id.trim().toLowerCase() === OPENWORK_MODELS_PROVIDER_ID);",
      replace: "return true || providerIds.length === 0; /* brandkit:hide-cloud — suppress OpenWork Models promos */",
    },
    // Hide the embedded "OpenWork Cloud — Sign in to share with team" banner
    // in the AI Providers settings panel.
    {
      id: "cloud:ai-cloud-banner",
      feature: "cloudHide",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/settings/pages/ai-view.tsx",
      find: "{props.cloudProvidersView}",
      replace: "{null /* brandkit:hide-cloud — cloud providers / share-with-team banner */}",
    },
    // Hide the now-empty "Cloud" group label in the settings sidebar (the
    // cloud tabs themselves are already emptied by cloud:settings-tabs).
    {
      id: "cloud:settings-group-label",
      feature: "cloudHide",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/settings/shell/settings-page.tsx",
      find: '<SidebarGroupLabel>{t("settings.group_cloud")}</SidebarGroupLabel>',
      replace: "{null /* brandkit:hide-cloud */}",
    },
    // A workspace already of type "remote" (e.g. carried over from before the
    // remote-create entry point was hidden) can still render Recover / Test
    // connection / Edit connection actions in its sidebar row menu. Null that
    // whole action block so no remote-worker action surface is reachable.
    {
      id: "cloud:sidebar-workers",
      feature: "cloudHide",
      type: "replaceAll",
      target: "apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx",
      pattern:
        '\\{workspace\\.workspaceType === "remote" \\? \\([\\s\\S]*?<\\/>\\s*\\) : null\\}',
      flags: "g",
      replace: "{null /* brandkit:hide-sidebar-remote-actions */}",
      signature: "brandkit:hide-sidebar-remote-actions",
    },
    // Hide the remote-worker entry: null the "connect custom remote" card in the
    // add-workspace chooser. `setScreen("remote")` is ONLY called from this card,
    // so removing it makes the whole remote-connect flow (RemoteWorkspaceFields)
    // unreachable — right for a local-only app with cloud/login hidden.
    {
      id: "cloud:hide-remote-workspace",
      feature: "cloudHide",
      type: "replaceAll",
      target: "apps/app/src/react-app/domains/workspace/create-workspace-modal.tsx",
      pattern:
        '<WorkspaceOptionCard\\s+title=\\{t\\("dashboard\\.create_remote_custom_title"\\)\\}[\\s\\S]*?onClick=\\{\\(\\) => setScreen\\("remote"\\)\\}\\s*/>',
      flags: "g",
      replace: "{null /* brandkit:hide-remote-workspace */}",
      signature: "brandkit:hide-remote-workspace",
    },

    // ---- Settings surface: trim to the essentials ---------------------------
    // Keep only: Preferences, Permissions, Extensions (workspace group) and
    // AI Providers, Appearance, Environment (global group). Hide Advanced,
    // Updates, Recovery, Debug, and the overview "Help" block. The two tab
    // functions are the single source of truth for BOTH nav surfaces (settings
    // sidebar + compact section menu).
    {
      id: "settings:workspace-tabs",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/settings/shell/settings-page.tsx",
      find: '  return ["preferences", "permissions", "extensions", "advanced"];',
      replace:
        '  return ["preferences", "permissions", "extensions"]; /* brandkit:trim-settings */',
    },
    {
      id: "settings:global-tabs",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/settings/shell/settings-page.tsx",
      find: [
        "  const tabs: SettingsTab[] = [\"ai\", \"appearance\", \"environment\"];\n  if (capabilities.autoUpdate) tabs.push(\"updates\");\n  if (capabilities.localRuntimeControl) tabs.push(\"recovery\");\n  if (developerMode) tabs.push(\"debug\");\n  return tabs;",
        "  const tabs: SettingsTab[] = [\"ai\", \"appearance\", \"environment\"];\r\n  if (capabilities.autoUpdate) tabs.push(\"updates\");\r\n  if (capabilities.localRuntimeControl) tabs.push(\"recovery\");\r\n  if (developerMode) tabs.push(\"debug\");\r\n  return tabs;",
      ],
      replace:
        '  return ["ai", "appearance", "environment"]; /* brandkit:trim-settings */',
    },
    // Keep the overview (General) grid in sync with the trimmed nav so hidden
    // tabs aren't reachable from the cards. Filter at render time (leaves the
    // card arrays + their icon imports intact — no orphaned imports).
    {
      id: "settings:general-workspace-cards",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/settings/pages/general-view.tsx",
      find: "{workspaceCards.map((card) => (",
      replace:
        '{workspaceCards.filter((brandCard) => ["preferences", "permissions", "extensions"].includes(brandCard.tab)).map((card) => (',
    },
    {
      id: "settings:general-global-cards",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/settings/pages/general-view.tsx",
      find: "{globalCards.map((card) => (",
      replace:
        '{globalCards.filter((brandCard) => ["ai", "appearance", "environment"].includes(brandCard.tab)).map((card) => (',
    },
    // Remove the overview "Help" block (Send feedback / Discord / Report issue).
    // Lazy match from the unique `{/* Feedback */}` comment up to the last
    // `</div>` before the closing `);` of the return (EOL-agnostic).
    {
      id: "settings:hide-help",
      feature: "trim",
      type: "replaceAll",
      target: "apps/app/src/react-app/domains/settings/pages/general-view.tsx",
      pattern: "\\{/\\* Feedback \\*/\\}[\\s\\S]*?(?=\\s*</div>\\s*\\);)",
      flags: "g",
      replace: "{null /* brandkit:hide-help */}",
      signature: "brandkit:hide-help",
    },
    // Drop the Docs + Feedback status-bar buttons.
    {
      id: "shell:hide-docs",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/shell/shell-config.tsx",
      find: "  docsButton: true,",
      replace: "  docsButton: false, /* brandkit:hide-docs */",
    },
    {
      id: "shell:hide-feedback",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/shell/shell-config.tsx",
      find: "  feedbackButton: true,",
      replace: "  feedbackButton: false, /* brandkit:hide-feedback */",
    },
    // Built-in browser: open new tabs to a blank page instead of google.com, so
    // no external request fires on every new tab (private/offline-friendly default).
    {
      id: "browser:new-tab-url",
      feature: "trim",
      type: "replaceString",
      target: "apps/desktop/electron/browser-panel.mjs",
      find: 'const BROWSER_NEW_TAB_URL = "https://www.google.com";',
      replace: 'const BROWSER_NEW_TAB_URL = "about:blank"; /* brandkit:new-tab-url */',
    },
    // FIX (no feature — always applied): the openwork-extensions-preview opencode
    // plugin — which registers the built-in browser-control tools the agent uses
    // for research — exports its factory PLUS 3 string constants and 3 helper
    // functions. opencode's plugin loader invokes every export as a plugin factory
    // and aborts on the first non-function ("Plugin export is not a function"), so
    // the plugin (and its browser tools) never loads and the agent falls back to
    // the external-Chrome browser-harness skill (which fails here) and webfetch.
    // Fix WITHOUT touching the source (its constants/helpers are used by tests):
    // ship a one-line entry module that re-exports only the factory, and point
    // opencode at that. bun bundles the whole plugin into the entry but exposes a
    // single (function) export — matching every plugin that loads cleanly.
    {
      id: "fix:plugin-entry-file",
      type: "writeFile",
      target: "apps/server/src/opencode-plugins/openwork-extensions-preview.entry.ts",
      content:
        `// AUTO-GENERATED by scripts/brandkit — single-export entry so opencode's\n` +
        `// plugin loader sees only the factory (see fix:plugin-entry-* ops).\n` +
        `export { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";\n`,
    },
    {
      id: "fix:plugin-entry-build",
      type: "replaceString",
      target: "apps/server/package.json",
      find: "bun build src/opencode-plugins/openwork-extensions-preview.ts src/opencode-plugins/openwork-capabilities-knowledge.ts",
      replace: "bun build src/opencode-plugins/openwork-extensions-preview.ts src/opencode-plugins/openwork-extensions-preview.entry.ts src/opencode-plugins/openwork-capabilities-knowledge.ts",
    },
    {
      id: "fix:plugin-entry-path",
      type: "replaceString",
      target: "apps/server/src/openwork-extensions-plugin-path.ts",
      find: 'export const openworkExtensionsPreviewPluginPath = () => openworkPluginPath("openwork-extensions-preview");',
      replace: 'export const openworkExtensionsPreviewPluginPath = () => openworkPluginPath("openwork-extensions-preview.entry");',
    },
    // Replace the stock "Browse the web → search Craigslist for couches" example
    // task (prompt + card copy) with a professional, business-oriented one.
    // Present in the legacy task-suggestions component and the current
    // empty-session hero.
    {
      id: "example:browser-prompt-suggestions",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/components/chat/task-suggestions.tsx",
      find: '"Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices."',
      replace: '"Open a company\'s website in the browser and summarize what they do, their products, and key details."',
    },
    {
      id: "example:browser-desc-suggestions",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/components/chat/task-suggestions.tsx",
      find: "<DescriptiveButtonDescription>Search Craigslist for couches</DescriptiveButtonDescription>",
      replace: "<DescriptiveButtonDescription>Research a company from its website</DescriptiveButtonDescription>",
    },
    {
      id: "example:browser-prompt-session",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/session/chat/session-empty-hero.tsx",
      find: '"Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices."',
      replace: '"Open a company\'s website in the browser and summarize what they do, their products, and key details."',
    },
    {
      id: "example:browser-desc-session",
      feature: "trim",
      type: "replaceString",
      target: "apps/app/src/react-app/domains/session/chat/session-empty-hero.tsx",
      find: 'description: "Use the built-in browser for repetitive steps.",',
      replace: 'description: "Research a company and summarize its website.",',
    },
  ];

  // ---- Providers: bake default model into the packaged runtime ------------
  // opencode.json (above) only reaches the DEV engine (it's the repo-root
  // config). The packaged app ships the COMPILED server, so the default model
  // must be injected into the runtime config object that becomes
  // OPENCODE_CONFIG. `runtimeConfig.model ?? default` keeps any user override.
  if (providers.default?.providerID && providers.default?.modelID) {
    const d = providers.default;
    const defaultModel = `${d.providerID}/${d.modelID}`;
    const providerModels = renderProviderModels(providers);
    // Inject a provider override into the PACKAGED runtime (which ships the
    // compiled server, not opencode.json): npm selects the wire protocol,
    // baseURL reroutes requests, and models defines the curated labels. Merge
    // with any existing runtimeConfig.provider rather than clobbering it.
    const providerBody = [
      d.npm ? `npm: ${JSON.stringify(d.npm)}` : null,
      d.name ? `name: ${JSON.stringify(d.name)}` : null,
      d.baseURL ? `options: { baseURL: ${JSON.stringify(d.baseURL)} }` : null,
      Object.keys(providerModels).length > 0 ? `models: ${JSON.stringify(providerModels)}` : null,
    ].filter(Boolean).join(", ");
    const providerOverride = providerBody
      ? `provider: { ...((runtimeConfig as { provider?: Record<string, unknown> }).provider ?? {}), ${JSON.stringify(d.providerID)}: { ${providerBody} } }, `
      : "";
    ops.push(
      {
        id: "providers:default-model",
        feature: "providers",
        type: "injectBefore",
        target: "apps/server/src/openwork-runtime-config.ts",
        marker: "brandkit:default-model",
        anchor: 'default_agent: runtimeConfig.default_agent ?? "openwork",',
        block: `model: (runtimeConfig as { model?: string }).model ?? ${JSON.stringify(defaultModel)}, ${providerOverride}/* brandkit:default-model */\r\n    `,
      },
      // The app's built-in DEFAULT_MODEL is a placeholder ("opencode/big-pickle").
      // Point it at the brand default so a fresh session shows the friendly
      // name, not "Big Pickle".
      {
        id: "providers:ui-default-provider",
        feature: "providers",
        type: "replaceString",
        target: "apps/app/src/app/constants.ts",
        find: '  providerID: "opencode",',
        replace: `  providerID: ${JSON.stringify(d.providerID)},`,
      },
      {
        id: "providers:ui-default-model",
        feature: "providers",
        type: "replaceString",
        target: "apps/app/src/app/constants.ts",
        find: '  modelID: "big-pickle",',
        replace: `  modelID: ${JSON.stringify(d.modelID)},`,
      },
    );
    // Relabel the PROVIDER surfaces (connected-provider row, model-picker group
    // description, icon initials) with the connector brand — distinct from the
    // model's own label (d.displayName, e.g. "Auto"). The provider brand comes
    // from keyCard.label (e.g. "Badlands Labs"), falling back to displayName.
    // opencode's raw provider name would otherwise leak into branded surfaces.
    const providerLabel = providers.keyCard?.label ?? d.displayName;
    if (d.displayName) {
      ops.push(
        {
          id: "providers:connected-relabel",
          feature: "providers",
          type: "replaceString",
          target: "apps/app/src/react-app/shell/settings-route.tsx",
          find: "name: provider.name ?? provider.id,",
          replace: `name: provider.id === ${JSON.stringify(d.providerID)} ? ${JSON.stringify(providerLabel)} : (provider.name ?? provider.id), /* brandkit:connected-relabel */`,
        },
        // Same relabel in both model-picker surfaces: the provider group's
        // `description` (shown under each model) is the raw catalog name.
        {
          id: "providers:picker-relabel-select",
          feature: "providers",
          type: "replaceString",
          target: "apps/app/src/components/model-select.tsx",
          find: "description: provider.name,",
          replace: `description: provider.id === ${JSON.stringify(d.providerID)} ? ${JSON.stringify(providerLabel)} : provider.name, /* brandkit:picker-relabel */`,
        },
        {
          id: "providers:picker-relabel-modal",
          feature: "providers",
          type: "replaceString",
          target: "apps/app/src/react-app/domains/session/modals/use-model-picker.ts",
          find: "description: provider.name,",
          replace: `description: provider.id === ${JSON.stringify(d.providerID)} ? ${JSON.stringify(providerLabel)} : provider.name, /* brandkit:picker-relabel */`,
        },
        // Hide the raw provider-id subtext (e.g. "openrouter") under the branded
        // name in the connected-provider row — the id would otherwise leak the
        // upstream even though the name is now the brand.
        {
          id: "providers:connected-id-hide",
          feature: "providers",
          type: "replaceString",
          target: "apps/app/src/react-app/domains/settings/pages/ai-view.tsx",
          find: 'text-muted-foreground">{provider.id}</div>',
          replace: `text-muted-foreground">{provider.id === ${JSON.stringify(d.providerID)} ? null : provider.id}</div>`,
        },
        // The provider icon falls back to hardcoded initials ("OR" for
        // openrouter). Swap them for the brand's initials so the icon badge
        // doesn't spell out the upstream.
        {
          id: "providers:icon-initials",
          feature: "providers",
          type: "injectBefore",
          target: "apps/app/src/react-app/design-system/provider-icon.tsx",
          marker: "brandkit:provider-initials",
          anchor: 'if (normalizedId === "openrouter") return "OR";',
          block: `if (normalizedId === ${JSON.stringify(d.providerID)}) return ${JSON.stringify(
            providerLabel.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
          )}; /* brandkit:provider-initials */\r\n    `,
        },
      );
    }
  }

  // ---- Provider picker enforcement (UI) -----------------------------------
  // Lock BOTH provider surfaces to the allowed set. The connect-list filter is
  // the real lock — only allowed providers can be connected, so every model
  // picker (which lists only CONNECTED providers) can only ever show allowed
  // models. The model-picker filter is belt-and-suspenders. Both use
  // injectBefore (marker-guarded → idempotent) at a newline-free anchor.
  if (providers.allowed.length > 0) {
    const allowed = `[${providers.allowed.map((id) => JSON.stringify(id)).join(", ")}]`;
    ops.push(
      {
        id: "providers:ui-filter",
        feature: "providers",
        type: "injectBefore",
        target: "apps/app/src/components/model-select.tsx",
        marker: "brandkit:providers-filter",
        anchor: ".flatMap((provider) =>",
        block: `.filter((brandProvider) => ${allowed}.includes(brandProvider.id)) /* brandkit:providers-filter */\r\n      `,
      },
      {
        id: "providers:connect-filter",
        feature: "providers",
        type: "injectBefore",
        target: "apps/app/src/react-app/domains/connections/provider-auth/provider-auth-modal.tsx",
        marker: "brandkit:connect-filter",
        anchor: ".sort(compareProviders);",
        block: `.filter((brandEntry) => ${allowed}.includes(brandEntry.id.trim().toLowerCase())) /* brandkit:connect-filter */\r\n      `,
      },
      // Hide already-connected non-allowed providers (env-detected keys like
      // OPENAI_API_KEY / ANTHROPIC_API_KEY, plus stored opencode creds) from the
      // AI Providers panel. Wraps the setter so the tracked `providerConnectedIds`
      // only ever holds allowed ids — keeps the list, the "N connected" summary,
      // and status badges consistent. opencode still loads them (UI-hide only).
      {
        id: "providers:connected-filter",
        feature: "providers",
        type: "replaceString",
        target: "apps/app/src/react-app/shell/settings-route.tsx",
        find: "setProviderConnectedIds,",
        replace: `setProviderConnectedIds: (brandIds) => setProviderConnectedIds(brandIds.filter((brandId) => ${allowed}.includes(brandId))), /* brandkit:connected-filter */`,
      },
    );

    // Restrict the model pickers to specific models within the allowed
    // provider(s). Two surfaces build model lists from getConnectedProviderItems:
    // the inline ModelSelect (model-select.tsx) and the "All models" modal
    // (use-model-picker.ts) — filter both. Empty list = all models allowed.
    // An entry ending in "/" is a VENDOR PREFIX (e.g. "anthropic/") that matches
    // every model of that vendor; other entries match a model id exactly. This
    // lets a single provider (e.g. openrouter behind a gateway) surface only a
    // few vendors' models without listing each id.
    if (providers.models.length > 0) {
      const models = `[${providers.models.map((m) => JSON.stringify(m)).join(", ")}]`;
      const matchModel = `((brandModelId) => ${models}.some((brandSel) => brandSel.endsWith("/") ? brandModelId.startsWith(brandSel) : brandModelId === brandSel))`;
      ops.push(
        {
          id: "providers:model-filter-select",
          feature: "providers",
          type: "injectBefore",
          target: "apps/app/src/components/model-select.tsx",
          marker: "brandkit:model-filter-select",
          anchor: ".map(([id, model]) =>",
          block: `.filter(([brandModelId]) => ${matchModel}(brandModelId)) /* brandkit:model-filter-select */\r\n        `,
        },
        {
          id: "providers:model-filter-picker-provider",
          feature: "providers",
          type: "replaceString",
          target: "apps/app/src/react-app/domains/session/modals/use-model-picker.ts",
          find: "for (const provider of getConnectedProviderItems(data)) {",
          replace: `for (const provider of getConnectedProviderItems(data).filter((brandProvider) => ${allowed}.includes(brandProvider.id))) {`,
        },
        {
          id: "providers:model-filter-picker-models",
          feature: "providers",
          type: "replaceString",
          target: "apps/app/src/react-app/domains/session/modals/use-model-picker.ts",
          find: "const modelIds = Object.keys(provider.models);",
          replace: `const modelIds = Object.keys(provider.models).filter(${matchModel});`,
        },
      );
    }

    // Because the connected list is filtered, an un-connected default provider
    // would leave the panel empty ("No providers connected yet") with nothing
    // pointing users to it. Render a brand-owned ALWAYS-VISIBLE key card for
    // the default provider: paste-a-key box (works whether or not a key is
    // already stored), inline validation against the provider API, and a
    // "starting up…" state while the local server client is not connected yet.
    if (providers.default?.providerID) {
      const dp = providers.default.providerID;
      ops.push(
        {
          id: "providers:key-card-module",
          feature: "providers",
          type: "writeFile",
          target: "apps/app/src/brandkit-generated/provider-key-card.tsx",
          content: renderProviderKeyCard(dp, language.default === "zh", providers.keyCard),
        },
        {
          id: "providers:key-card-import",
          feature: "providers",
          type: "injectBefore",
          target: "apps/app/src/react-app/domains/settings/pages/ai-view.tsx",
          marker: "brandkit:key-card-import",
          anchor: 'import { t } from "@/i18n";',
          block: `import { BrandProviderKeyCard } from "@/brandkit-generated/provider-key-card"; /* brandkit:key-card-import */\r\n`,
        },
        {
          id: "providers:key-card-render",
          feature: "providers",
          type: "injectBefore",
          target: "apps/app/src/react-app/domains/settings/pages/ai-view.tsx",
          // NB: must not be a substring of any other marker in this file — the
          // idempotency guard is a plain includes() check.
          marker: "brandkit:key-card-render",
          anchor: "{props.showOpenWorkModelsConnect ? (",
          block: [
            `{/* brandkit:key-card-render */}`,
            `        <BrandProviderKeyCard`,
            `          connected={props.connectedProviders.some((brandProvider) => brandProvider.id === ${JSON.stringify(dp)})}`,
            `          clientReady={(props as { brandClientReady?: boolean }).brandClientReady !== false}`,
            `          busy={props.busy || props.providerAuthBusy}`,
            `          submitApiKey={(props as { brandSubmitApiKey?: (providerId: string, apiKey: string) => Promise<string | void> }).brandSubmitApiKey}`,
            `          onFallbackConnect={props.onOpenProviderAuth}`,
            `        />`,
            `        `,
          ].join("\r\n"),
        },
        // Feed the card its two extra inputs from the settings container:
        // whether the workspace server client is attached, and the store's
        // direct api-key submit (the same call the Connect modal makes).
        {
          id: "providers:key-card-props",
          feature: "providers",
          type: "injectBefore",
          target: "apps/app/src/react-app/shell/settings-route.tsx",
          marker: "brandkit:key-card-props",
          anchor: "providerConnectError={providerAuthSnapshot.providerAuthError}",
          block:
            `{...({ brandClientReady: Boolean(activeClient), brandSubmitApiKey: providerAuthStore.submitProviderApiKey } as object)} /* brandkit:key-card-props */\r\n            `,
        },
        // While the server is still starting, the card already explains what's
        // happening — suppress the raw red "Not connected to a server" notice.
        {
          id: "providers:error-gate",
          feature: "providers",
          type: "replaceString",
          target: "apps/app/src/react-app/domains/settings/pages/ai-view.tsx",
          find: "{props.providerConnectError ? (",
          replace:
            "{props.providerConnectError && (props as { brandClientReady?: boolean }).brandClientReady !== false ? ( /* brandkit:error-gate */",
        },
      );
    }
  }

  // ---- Single-language variant (BRANDKIT_LANG) ------------------------------
  // `BRANDKIT_LANG=zh` (or language.default in config) forces the default
  // locale on every launch, merges the kit's translations into the upstream
  // locale file, overrides hardcoded component literals, and hides the
  // Appearance language switcher — a hard-locked single-language build.
  // The static ops are ALWAYS in the list; for an English build the group is
  // inactive (see enabledFeatures) and apply cleans up a previous variant's
  // edits, so one checkout can alternate en/zh builds.
  ops.push(
    {
      id: "lang:default-locale",
      feature: "language",
      type: "replaceString",
      target: "apps/app/src/i18n/index.ts",
      find: 'let localeValue: Language = "en";',
      replace: `let localeValue: Language = ${JSON.stringify(language.default)}; /* brandkit:lang */`,
    },
    // Force the brand locale even if a prior session persisted another: make
    // initLocale() read the stored pref as the brand default so it always
    // resolves to it. (The English *translation* fallback in lookupEntry is
    // deliberately untouched — untranslated keys still render in English.)
    {
      id: "lang:force",
      feature: "language",
      type: "replaceString",
      target: "apps/app/src/i18n/index.ts",
      find: "const stored = window.localStorage.getItem(LANGUAGE_PREF_KEY);",
      replace: `const stored = ${JSON.stringify(language.default)}; /* brandkit:lang-lock */`,
    },
    {
      id: "lang:hide-switcher",
      feature: "language",
      type: "replaceAll",
      target: "apps/app/src/react-app/domains/settings/pages/appearance-view.tsx",
      pattern: "<Separator />\\s*<LanguageSection \\{\\.\\.\\.props\\} />",
      flags: "g",
      replace: "{null /* brandkit:lang-lock */}",
      signature: "brandkit:lang-lock",
    },
  );
  // Locale-file translation overlays: built for the ACTIVE lang when a variant
  // is on; for an English build they're built (disabled) for every
  // brand/i18n/*.json lang instead, so cleanup covers whichever variant was
  // applied before.
  for (const lang of overlayLangs(language)) {
    ops.push({
      id: `lang:translations-${lang}`,
      feature: "language",
      type: "mergeLocale",
      target: `apps/app/src/i18n/locales/${lang}.ts`,
      source: `brand/i18n/${lang}.json`,
      // Kit JSON stays brand-agnostic; the brand token resolves at merge time.
      substitutions: { "{BRAND}": displayName },
    });
  }

  return ops;
}

/**
 * Which languages need translation-overlay ops. Active variant → just that
 * lang; English build → every lang with a kit JSON, purely so the (disabled)
 * ops' targets get cleaned up by apply after switching back from a variant.
 */
function overlayLangs(language) {
  if (language.default !== "en") return [language.default];
  try {
    return readdirSync(resolve(REPO_ROOT, "brand/i18n"))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".ui.json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

function renderOpencodeJson(providers) {
  const doc = { $schema: "https://opencode.ai/config.json" };
  const d = providers.default;
  if (d?.providerID && d?.modelID) {
    doc.model = `${d.providerID}/${d.modelID}`;
    // Custom providers need the matching AI SDK package to select the wire
    // protocol. Other fields also work as overlays for catalog providers.
    const entry = {};
    if (d.npm) entry.npm = d.npm;
    if (d.name) entry.name = d.name;
    if (d.baseURL) entry.options = { baseURL: d.baseURL };
    const providerModels = renderProviderModels(providers);
    if (Object.keys(providerModels).length > 0) entry.models = providerModels;
    if (Object.keys(entry).length > 0) doc.provider = { [d.providerID]: entry };
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function renderProviderModels(providers) {
  const d = providers.default;
  if (!d?.modelID) return {};
  const configuredIds = d.npm
    ? providers.models.filter((modelId) => !modelId.endsWith("/"))
    : [d.modelID];
  const modelIds = [...new Set([d.modelID, ...configuredIds])];
  return Object.fromEntries(modelIds.map((modelId) => [
    modelId,
    {
      name:
        providers.modelNames?.[modelId] ??
        (modelId === d.modelID ? d.displayName : null) ??
        modelId,
    },
  ]));
}

/** The brand-owned welcome page, generated from the `welcome` config block. */
function renderWelcomeOverride(welcome) {
  const consts =
    `const SHOW_SIGN_IN = ${welcome.showSignIn === true};\n` +
    `const TITLE = ${JSON.stringify(welcome.title ?? null)};\n` +
    `const SUBTITLE = ${JSON.stringify(welcome.subtitle ?? null)};\n` +
    `const GET_STARTED_HEADING = ${JSON.stringify(welcome.getStartedHeading ?? "Get started")};\n` +
    `const GET_STARTED_LABEL = ${JSON.stringify(welcome.getStartedLabel ?? null)};\n` +
    `const SHOWCASE_TITLE = ${JSON.stringify(welcome.showcaseTitle)};\n` +
    `const STEPS = ${JSON.stringify(welcome.steps, null, 2)};\n` +
    `const FEATURES = ${JSON.stringify(welcome.features, null, 2)};\n`;

  return `/** @jsxImportSource react */
// AUTO-GENERATED by scripts/brandkit — edit brands/<id>/brand.json (welcome section)
// and re-run \`node scripts/brandkit/apply.mjs\`. This brand-owned file is served
// in place of apps/app/src/react-app/domains/onboarding/welcome-page.tsx via the
// brandkit reroute Vite plugin (the original source is never modified).
import type { ReactNode } from "react";

import { t } from "@/i18n";
import {
  Page,
  PageBackground,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitlebarRegion,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";

// ---- Brand-configurable content (from brands/<id>/brand.json) --------------
${consts}// ---------------------------------------------------------------------------

type WelcomePageProps = {
  onGetStarted: () => void;
  getStartedLabel?: string;
  busy?: boolean;
  error?: string | null;
  manualFolder?: string;
  onManualFolderChange?: (value: string) => void;
  onUseManualFolder?: () => void;
  showManualFolder?: boolean;
  onTeamSignIn?: () => void;
};

type OnboardingStepProps = { number: string; title: string; children: ReactNode };

function OnboardingStep({ number, title, children }: OnboardingStepProps) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-sm font-medium text-foreground">
        {number}
      </div>
      <div className="flex flex-col gap-0.5 pt-1">
        <div className="text-base font-medium text-foreground">{title}</div>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function ShowcasePanel() {
  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
        {SHOWCASE_TITLE.map((line, i) => (
          <span key={i}>
            {line}
            {i < SHOWCASE_TITLE.length - 1 ? <br /> : null}
          </span>
        ))}
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {FEATURES.map((cap) => (
          <div key={cap.title} className="flex flex-col gap-2.5 rounded-xl border border-border p-3">
            <div className="size-4 rounded-[5px] bg-[var(--dls-accent,theme(colors.foreground))]" />
            <div className="text-sm font-medium leading-tight text-foreground">{cap.title}</div>
            <div className="text-xs leading-snug text-muted-foreground">{cap.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WelcomePage({
  onGetStarted,
  getStartedLabel,
  busy,
  error,
  manualFolder,
  onManualFolderChange,
  onUseManualFolder,
  showManualFolder,
  onTeamSignIn,
}: WelcomePageProps) {
  return (
    <Page className="min-h-screen">
      <PageBackground />
      <PageTitlebarRegion />
      <ScrollArea className="relative z-10">
        <ScrollAreaViewport>
          <div className="flex min-h-screen">
            {/* ---- Left: onboarding steps ---- */}
            <div className="flex w-full flex-col items-center justify-center px-8 py-16 lg:w-[45%] lg:px-12">
              <div className="flex w-full max-w-md flex-col gap-10">
                <PageHeader className="text-left">
                  <PageTitle>{TITLE ?? t("welcome.title")}</PageTitle>
                  <PageDescription>{SUBTITLE ?? t("welcome.subtitle")}</PageDescription>
                </PageHeader>

                <div className="flex flex-col gap-4">
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">{GET_STARTED_HEADING}</h2>
                  {STEPS.map((step, i) => (
                    <OnboardingStep key={step.title} number={String(i + 1)} title={step.title}>
                      {step.desc}
                    </OnboardingStep>
                  ))}
                </div>

                <div className="space-y-2">
                  <Button size="lg" className="w-full" onClick={onGetStarted} disabled={busy}>
                    {busy ? t("welcome.creating_workspace") : GET_STARTED_LABEL || getStartedLabel || t("welcome.get_started")}
                  </Button>
                  {SHOW_SIGN_IN && onTeamSignIn ? (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto w-full p-0 text-sm text-muted-foreground"
                      onClick={onTeamSignIn}
                      data-testid="welcome-team-signin"
                    >
                      {t("welcome.team_signin")}
                    </Button>
                  ) : null}
                  {error ? <p className="text-center text-xs text-destructive">{error}</p> : null}
                  {showManualFolder ? (
                    <div className="rounded-xl border border-dashed border-border p-3">
                      <label className="grid gap-2 text-xs font-medium text-muted-foreground">
                        Folder path
                        <input
                          className="h-9 rounded-md border border-input bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-ring"
                          value={manualFolder ?? ""}
                          onChange={(event) => onManualFolderChange?.(event.target.value)}
                          placeholder="/workspace/my-project"
                        />
                      </label>
                      <Button
                        className="mt-2 w-full"
                        variant="outline"
                        onClick={onUseManualFolder}
                        disabled={busy || !manualFolder?.trim()}
                      >
                        Use this folder
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* ---- Right: showcase card ---- */}
            <div className="hidden lg:flex lg:w-[55%] lg:items-center lg:justify-center lg:p-6">
              <div className="relative w-full max-w-xl overflow-hidden rounded-3xl border border-border">
                <div className="absolute inset-0 z-0 bg-[var(--dls-accent,theme(colors.muted.DEFAULT))] opacity-10" />
                <div className="relative z-10 m-3 rounded-2xl bg-background p-7">
                  <ShowcasePanel />
                </div>
              </div>
            </div>
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </Page>
  );
}
`;
}

/**
 * The brand Vite config. Lives in apps/app (additive — the app's own
 * vite.config.ts is never modified) so Vite's temp-config bundling resolves
 * `vite` and the app plugins from apps/app/node_modules. Registers the reroute
 * plugin and maps the welcome-page module to the brand override.
 */
function renderBrandViteConfig(withWelcomeOverride) {
  const overrides = withWelcomeOverride
    ? `{
    [resolve(APP_ROOT, "src/react-app/domains/onboarding/welcome-page.tsx")]:
      resolve(APP_ROOT, "src/brandkit-generated/welcome-page.tsx"),
  }`
    : `/* features.welcomeOverride = false — no modules rerouted */ {}`;

  return `// AUTO-GENERATED by scripts/brandkit. Additive file — the app's own
// vite.config.ts is never modified. Loads the real config unchanged and layers
// in the reroute plugin so brand-owned overrides replace specific modules.
//
// Build/run the branded app with this config:
//   vite --config vite.brandkit.config.mts          (dev, cwd = apps/app)
//   vite build --config vite.brandkit.config.mts     (build, cwd = apps/app)
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";

import base from "./vite.config";
import { brandkitReroute } from "../../scripts/brandkit/vite-reroute-plugin.mjs";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(APP_ROOT, "..", "..");

const reroute = brandkitReroute({
  overrides: ${overrides},
});

// Prepend the reroute plugin (so its \`pre\` resolveId wins), keep the app's
// plugins/alias intact, pin root, and let Vite serve the override from brand/.
export default mergeConfig(mergeConfig({ plugins: [reroute] }, base), {
  root: APP_ROOT,
  server: { fs: { allow: [REPO_ROOT] } },
});
`;
}
/** Per-provider metadata for the inline key card. */
const KEY_CARD_PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    keysUrl: "https://openrouter.ai/keys",
    // GET with a Bearer key returns 200 for a live key, 401/403 for a bad one.
    // OpenRouter's API is CORS-open, so the renderer can call it directly.
    validateUrl: "https://openrouter.ai/api/v1/key",
    keyPrefix: "sk-or-",
  },
  openai: {
    label: "OpenAI",
    keysUrl: "https://platform.openai.com/api-keys",
    validateUrl: null, // CORS-blocked from a renderer; skip inline validation
    keyPrefix: "sk-",
  },
  anthropic: {
    label: "Anthropic",
    keysUrl: "https://console.anthropic.com/settings/keys",
    validateUrl: null,
    keyPrefix: "sk-ant-",
  },
};

/**
 * Brand-owned "paste your API key" card for the default provider. Written to
 * apps/app/src/brandkit-generated/ (gitignored) and injected into the AI
 * Providers settings panel. Always visible: shows saved-state, replace-key,
 * inline validation, and a "starting up" state while the local server client
 * is not attached yet.
 */
function renderProviderKeyCard(providerId, zh, overrides) {
  // Base metadata comes from the built-in catalog; the optional `keyCard` config
  // block overrides it so the card can present a branded gateway (label,
  // validation URL) instead of the underlying provider. `undefined` override
  // fields fall back to the catalog; explicit `null` clears (e.g. keyPrefix).
  const base = KEY_CARD_PROVIDERS[providerId] ?? {
    label: providerId,
    keysUrl: null,
    validateUrl: null,
    keyPrefix: null,
  };
  const meta = { ...base };
  if (overrides && typeof overrides === "object") {
    for (const field of ["label", "keysUrl", "validateUrl", "keyPrefix"]) {
      if (field in overrides) meta[field] = overrides[field];
    }
  }
  const L = {
    apiKeySuffix: zh ? " API 密钥" : " API key",
    startingUp: zh ? "启动中" : "Starting up",
    keySaved: zh ? "密钥已保存" : "Key saved",
    noKeyYet: zh ? "尚未设置密钥" : "No key yet",
    startingEngine: zh
      ? "正在启动本地引擎。首次安装后可能需要一分钟——准备好后下方输入框会自动解锁。"
      : "Starting the local engine. This can take a minute the first time after installing — the box below unlocks automatically when it's ready.",
    keyOnFile: zh
      ? "此电脑上已保存密钥。在下方粘贴新密钥即可替换。"
      : "A key is saved on this computer. Paste a new key below to replace it.",
    pasteKeyPrefix: zh ? "在下方粘贴你的 " : "Paste your ",
    pasteKeySuffix: zh ? " API 密钥即可开始。" : " API key below to get started.",
    getAKey: zh ? "获取密钥" : "Get a key",
    waitingEngine: zh ? "等待本地引擎启动…" : "Waiting for the local engine...",
    apiKeyPlaceholder: zh ? "API 密钥" : "API key",
    saving: zh ? "保存中…" : "Saving...",
    replaceKey: zh ? "更换密钥" : "Replace key",
    saveKey: zh ? "保存密钥" : "Save key",
    rejectedMid: zh ? " 拒绝了此密钥。请确认已完整复制密钥" : " rejected this key. Make sure you copied the whole key",
    rejectedPrefixHintStart: zh ? "（应以 " : " (it starts with ",
    rejectedPrefixHintEnd: zh ? " 开头）" : ")",
    rejectedEnd: zh ? "，然后重试。" : " and try again.",
    verifiedSaved: zh ? "密钥已验证并保存，可以开始使用了。" : "Key verified and saved. You're ready to go.",
    savedUnverified: zh
      ? "密钥已保存。目前无法验证，将在首次使用时进行检查。"
      : "Key saved. It couldn't be verified right now, so it will be checked on first use.",
    couldNotSave: zh ? "无法保存密钥：" : "Couldn't save the key: ",
  };

  return `/** @jsxImportSource react */
// AUTO-GENERATED by scripts/brandkit — edit brands/<id>/brand.json / operations.mjs
// and re-run \`node scripts/brandkit/apply.mjs\`. Injected into the AI Providers
// settings panel; the upstream ai-view.tsx is only touched by marker-guarded
// build-time injections.
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { LayoutSectionItem } from "@/react-app/domains/settings/settings-layout";

const PROVIDER_ID = ${JSON.stringify(providerId)};
const PROVIDER_LABEL = ${JSON.stringify(meta.label)};
const KEYS_URL = ${JSON.stringify(meta.keysUrl)};
const VALIDATE_URL = ${JSON.stringify(meta.validateUrl)};
const KEY_PREFIX = ${JSON.stringify(meta.keyPrefix)};
const L_API_KEY_SUFFIX = ${JSON.stringify(L.apiKeySuffix)};
const L_STARTING_UP = ${JSON.stringify(L.startingUp)};
const L_KEY_SAVED = ${JSON.stringify(L.keySaved)};
const L_NO_KEY_YET = ${JSON.stringify(L.noKeyYet)};
const L_STARTING_ENGINE = ${JSON.stringify(L.startingEngine)};
const L_KEY_ON_FILE = ${JSON.stringify(L.keyOnFile)};
const L_PASTE_KEY_PREFIX = ${JSON.stringify(L.pasteKeyPrefix)};
const L_PASTE_KEY_SUFFIX = ${JSON.stringify(L.pasteKeySuffix)};
const L_GET_A_KEY = ${JSON.stringify(L.getAKey)};
const L_WAITING_ENGINE = ${JSON.stringify(L.waitingEngine)};
const L_API_KEY_PLACEHOLDER = ${JSON.stringify(L.apiKeyPlaceholder)};
const L_SAVING = ${JSON.stringify(L.saving)};
const L_REPLACE_KEY = ${JSON.stringify(L.replaceKey)};
const L_SAVE_KEY = ${JSON.stringify(L.saveKey)};
const L_REJECTED_MID = ${JSON.stringify(L.rejectedMid)};
const L_REJECTED_PREFIX_HINT_START = ${JSON.stringify(L.rejectedPrefixHintStart)};
const L_REJECTED_PREFIX_HINT_END = ${JSON.stringify(L.rejectedPrefixHintEnd)};
const L_REJECTED_END = ${JSON.stringify(L.rejectedEnd)};
const L_VERIFIED_SAVED = ${JSON.stringify(L.verifiedSaved)};
const L_SAVED_UNVERIFIED = ${JSON.stringify(L.savedUnverified)};
const L_COULD_NOT_SAVE = ${JSON.stringify(L.couldNotSave)};

export type BrandProviderKeyCardProps = {
  connected: boolean;
  clientReady: boolean;
  busy: boolean;
  submitApiKey?: (providerId: string, apiKey: string) => Promise<string | void>;
  onFallbackConnect: () => void | Promise<void>;
};

type Notice = { tone: "ok" | "warn" | "error"; text: string };

async function validateKey(candidate: string): Promise<"valid" | "invalid" | "unknown"> {
  if (!VALIDATE_URL) return "unknown";
  try {
    const response = await fetch(VALIDATE_URL, {
      headers: { Authorization: "Bearer " + candidate },
    });
    if (response.ok) return "valid";
    if (response.status === 401 || response.status === 403) return "invalid";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function BrandProviderKeyCard(props: BrandProviderKeyCardProps) {
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const startingUp = !props.clientReady;
  const disabled = startingUp || saving || props.busy;

  async function save() {
    const candidate = keyInput.trim();
    if (!candidate || saving) return;
    if (!props.submitApiKey) {
      // Container wiring drifted — fall back to the standard connect modal.
      void props.onFallbackConnect();
      return;
    }
    setSaving(true);
    setNotice(null);
    const verdict = await validateKey(candidate);
    if (verdict === "invalid") {
      setNotice({
        tone: "error",
        text:
          PROVIDER_LABEL +
          L_REJECTED_MID +
          (KEY_PREFIX ? L_REJECTED_PREFIX_HINT_START + KEY_PREFIX + L_REJECTED_PREFIX_HINT_END : "") +
          L_REJECTED_END,
      });
      setSaving(false);
      return;
    }
    try {
      await props.submitApiKey(PROVIDER_ID, candidate);
      setKeyInput("");
      setNotice(
        verdict === "valid"
          ? { tone: "ok", text: L_VERIFIED_SAVED }
          : {
              tone: "warn",
              text: L_SAVED_UNVERIFIED,
            },
      );
    } catch (error) {
      setNotice({
        tone: "error",
        text: L_COULD_NOT_SAVE + (error instanceof Error ? error.message : String(error)),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <LayoutSectionItem className="rounded-2xl border border-dls-border px-4 py-4">
      <div className="flex w-full flex-col gap-3">
        <div className="flex items-center gap-3">
          <ProviderIcon providerId={PROVIDER_ID} size={20} className="text-dls-text" />
          <span className="text-sm font-medium text-dls-text">{PROVIDER_LABEL}{L_API_KEY_SUFFIX}</span>
          <span
            className={
              "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium " +
              (startingUp
                ? "border-amber-6 bg-amber-2 text-amber-11"
                : props.connected
                  ? "border-green-6 bg-green-2 text-green-11"
                  : "border-dls-border bg-dls-sidebar/40 text-muted-foreground")
            }
          >
            {startingUp ? L_STARTING_UP : props.connected ? L_KEY_SAVED : L_NO_KEY_YET}
          </span>
        </div>

        {startingUp ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-amber-9" />
            {L_STARTING_ENGINE}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {props.connected
              ? L_KEY_ON_FILE
              : L_PASTE_KEY_PREFIX + PROVIDER_LABEL + L_PASTE_KEY_SUFFIX}
            {KEYS_URL ? (
              <>
                {" "}
                <a
                  href={KEYS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-dls-text"
                >
                  {L_GET_A_KEY}
                </a>
              </>
            ) : null}
          </div>
        )}

        <div className="flex w-full gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground outline-none focus:border-ring disabled:opacity-50"
            placeholder={
              startingUp
                ? L_WAITING_ENGINE
                : (KEY_PREFIX ? KEY_PREFIX + "..." : L_API_KEY_PLACEHOLDER)
            }
            value={keyInput}
            disabled={disabled}
            onChange={(event) => setKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            data-testid="brandkit-provider-key-input"
          />
          <Button
            className="shrink-0"
            onClick={() => void save()}
            disabled={disabled || !keyInput.trim()}
          >
            {saving ? L_SAVING : props.connected ? L_REPLACE_KEY : L_SAVE_KEY}
          </Button>
        </div>

        {notice ? (
          <div
            className={
              "text-xs " +
              (notice.tone === "error"
                ? "text-destructive"
                : notice.tone === "warn"
                  ? "text-amber-11"
                  : "text-green-11")
            }
            data-testid="brandkit-provider-key-notice"
          >
            {notice.text}
          </div>
        ) : null}
      </div>
    </LayoutSectionItem>
  );
}
`;
}
