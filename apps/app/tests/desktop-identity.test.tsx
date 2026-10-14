import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeDenDesktopConfig, type DenDesktopConfig } from "../src/app/lib/den";
import { desktopCapabilityConfig } from "@openwork/types/den/desktop-policies";
import { BrandThemeEffect, useBrandAppName, useBrandLogoUrl } from "../src/react-app/domains/cloud/brand-theme";
import { bootstrapBrandingNeedsSync, brandIconReconcileAction, hasWorkspaceBranding } from "../src/react-app/domains/cloud/workspace-branding-restart";
import { DenSignInSurface, type DenSignInSurfaceProps } from "../src/react-app/domains/cloud/den-signin-surface";
import * as desktopConfig from "../src/react-app/domains/cloud/desktop-config-provider";
import { DesktopPolicyNotificationEffect } from "../src/react-app/domains/cloud/desktop-policy-notification-effect";
import { useNotificationStore } from "../src/react-app/kernel/notification-store";

const legacyBranding = {
  brandAppName: "Custom Workspace",
  brandLogoUrl: "https://example.test/custom-logo.svg",
  brandIconUrl: "https://example.test/custom-icon.png",
  brandAccentColor: "purple" as const,
};

const signInProps: DenSignInSurfaceProps = {
  variant: "fullscreen",
  developerMode: false,
  baseUrl: "https://den.example.test",
  baseUrlDraft: "https://den.example.test",
  baseUrlError: null,
  statusMessage: null,
  authError: null,
  authBusy: false,
  baseUrlBusy: false,
  sessionBusy: false,
  manualAuthOpen: false,
  manualAuthInput: "",
  onBaseUrlDraftInput: () => {},
  onResetBaseUrl: () => {},
  onApplyBaseUrl: () => {},
  onOpenControlPlane: () => {},
  onOpenBrowserAuth: () => {},
  onToggleManualAuth: () => {},
  onManualAuthInput: () => {},
  onSubmitManualAuth: () => {},
};

test("sign-in always uses OpenWork identity, ignoring legacy presentation overrides", () => {
  const legacyProps = {
    ...signInProps,
    appName: legacyBranding.brandAppName,
    logoUrl: legacyBranding.brandLogoUrl,
  };
  const markup = renderToStaticMarkup(<DenSignInSurface {...legacyProps} />);
  expect(markup).toContain("Welcome to OpenWork");
  expect(markup).toContain("openwork-mark.svg");
  expect(markup).not.toContain("Custom Workspace");
  expect(markup).not.toContain("custom-logo.svg");
});

test("desktop config keeps source settings but projects stock without an explicit feature decision", () => {
  const normalized = normalizeDenDesktopConfig({
    ...legacyBranding,
    allowCustomProviders: false,
    connectEnabled: true,
    onboardingPrompts: ["Summarize my files", "Plan my week"],
  });
  expect(normalized).toMatchObject(legacyBranding);
  expect(desktopCapabilityConfig(normalized)).toEqual({
    allowCustomProviders: false,
    connectEnabled: true,
    onboardingPrompts: ["Summarize my files", "Plan my week"],
  });
  expect(desktopCapabilityConfig({ ...normalized, whiteLabelEnabled: true })).toMatchObject(legacyBranding);
});

test("sign-in custom appearance requires the explicit backend projection", () => {
  const markup = renderToStaticMarkup(<DenSignInSurface {...signInProps}
    whiteLabelEnabled={true} appName={legacyBranding.brandAppName} logoUrl={legacyBranding.brandLogoUrl} />);
  expect(markup).toContain("Welcome to Custom Workspace");
  expect(markup).toContain("custom-logo.svg");
});

test("bootstrap rollback only changes the flag, and restart/icon helpers are safe off", () => {
  for (const whiteLabelEnabled of [undefined, false]) {
    const config = { ...legacyBranding, whiteLabelEnabled };
    expect(hasWorkspaceBranding(config)).toBe(false);
    expect(brandIconReconcileAction(config, { applied: true })).toEqual({ apply: null });
    expect(bootstrapBrandingNeedsSync({ ...legacyBranding, whiteLabelEnabled: false }, config)).toBe(false);
  }
  const enabled = { ...legacyBranding, whiteLabelEnabled: true };
  expect(hasWorkspaceBranding(enabled)).toBe(true);
  expect(brandIconReconcileAction(enabled, { applied: false })).toEqual({ apply: legacyBranding.brandIconUrl });
  expect(bootstrapBrandingNeedsSync({ ...legacyBranding, whiteLabelEnabled: false }, enabled)).toBe(true);
});

describe("independent desktop policy notification", () => {
  let actEnvironment: unknown;

  beforeEach(() => {
    GlobalRegistrator.register({ url: "http://localhost:5173/" });
    actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    useNotificationStore.getState().clearAll();
  });

  afterEach(async () => {
    useNotificationStore.getState().clearAll();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    await GlobalRegistrator.unregister();
  });

  test("branding hooks and accent reset on false/missing and return when enabled again", async () => {
    let config: DenDesktopConfig = { ...legacyBranding, whiteLabelEnabled: true };
    const restrictions = spyOn(desktopConfig, "useOrgRestrictions").mockImplementation(() => config);
    function Appearance() {
      return <><BrandThemeEffect /><span>{useBrandAppName()}</span><img src={useBrandLogoUrl()} /></>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Appearance />));
      expect(container.textContent).toBe("Custom Workspace");
      expect(container.innerHTML).toContain("custom-logo.svg");
      expect(document.documentElement.dataset.brandAccent).toBe("purple");
      for (const whiteLabelEnabled of [false, undefined, true]) {
        config = { ...legacyBranding, whiteLabelEnabled };
        await act(async () => root.render(<Appearance />));
        expect(container.textContent).toBe(whiteLabelEnabled === true ? "Custom Workspace" : "OpenWork");
        expect(document.documentElement.dataset.brandAccent).toBe(whiteLabelEnabled === true ? "purple" : undefined);
      }
    } finally {
      await act(async () => root.unmount());
      restrictions.mockRestore();
    }
  });

  test("notifies for restrictions, never for legacy branding, and only once per mount", async () => {
    let config: DenDesktopConfig = { ...legacyBranding, allowCustomProviders: true };
    const restrictions = spyOn(desktopConfig, "useOrgRestrictions").mockImplementation(() => config);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<DesktopPolicyNotificationEffect />));
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      config = { allowCustomProviders: false };
      await act(async () => root.render(<DesktopPolicyNotificationEffect />));
      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.title).toBe("Organization policies active");
      expect(notifications[0]?.body).toBe("Some features are managed by your administrator.");

      config = { allowCustomProviders: false, connectEnabled: false };
      await act(async () => root.render(<DesktopPolicyNotificationEffect />));
      expect(useNotificationStore.getState().notifications[0]?.count).toBe(1);
    } finally {
      await act(async () => root.unmount());
      restrictions.mockRestore();
    }
  });
});
