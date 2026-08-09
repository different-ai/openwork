import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const composerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
);
const sessionSurfacePath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
);
const sessionRoutePath = fileURLToPath(
  new URL("../src/react-app/shell/session-route.tsx", import.meta.url),
);
const sessionProviderAuthPath = fileURLToPath(
  new URL("../src/react-app/domains/connections/provider-auth/use-session-provider-auth.ts", import.meta.url),
);
const providerAuthModalPath = fileURLToPath(
  new URL("../src/react-app/domains/connections/provider-auth/provider-auth-modal.tsx", import.meta.url),
);

describe("composer model controls", () => {
  test("stay enabled during ordinary generation and disable during steering", () => {
    const composerSource = readFileSync(composerPath, "utf8");
    const modelSelectStart = composerSource.indexOf("<ModelSelect");
    const behaviorSelectStart = composerSource.indexOf("<ModelBehaviorSelect");
    const modelControls = [
      composerSource.slice(modelSelectStart, composerSource.indexOf("/>", modelSelectStart) + 2),
      composerSource.slice(behaviorSelectStart, composerSource.indexOf("/>", behaviorSelectStart) + 2),
    ].join("\n");

    expect(modelControls.match(/disabled=\{props\.steering\}/g)).toHaveLength(2);
    expect(modelControls).not.toContain("disabled={props.busy}");
  });

  test("tracks steering until the active run stops streaming", () => {
    const sessionSurfaceSource = readFileSync(sessionSurfacePath, "utf8");

    expect(sessionSurfaceSource).toContain("setSteering(true);\n    await handleSend();");
    expect(sessionSurfaceSource).toContain("if (!chatStreaming) setSteering(false);");
    expect(sessionSurfaceSource).toContain("steering={steering}");
  });

  test("makes the unavailable-model hint a compact refresh control", () => {
    const composerSource = readFileSync(composerPath, "utf8");

    expect(composerSource).toContain("await props.onRefreshOrganizationModels();");
    expect(composerSource).toContain("disabled={refreshingOrganizationModels}");
    expect(composerSource).toContain("max-w-full");
    expect(composerSource).toContain("sm:max-w-80");
    expect(composerSource).toContain("min-w-0 truncate");
    expect(composerSource).toContain('t("models.retry_organization_models")');
  });

  test("updates the session cloud-provider snapshot after a manual retry", () => {
    const sessionRouteSource = readFileSync(sessionRoutePath, "utf8");
    const sessionProviderAuthSource = readFileSync(sessionProviderAuthPath, "utf8");

    expect(sessionRouteSource).toContain('await refreshCloudProviderSync("manual");');
    expect(sessionProviderAuthSource).toContain(
      "setCompletedCloudProviderSync({ context: cloudProviderSyncContext, providerList });",
    );
  });

  test("does not offer organization-provider connect actions in the model picker", () => {
    const sessionRouteSource = readFileSync(sessionRoutePath, "utf8");
    const providerAuthModalSource = readFileSync(providerAuthModalPath, "utf8");

    expect(sessionRouteSource).not.toContain("onConnectCloud" + "Provider");
    expect(providerAuthModalSource).not.toContain("onConnectCloud" + "Provider");
    expect(providerAuthModalSource).not.toContain("Connect organization provider");
  });
});
