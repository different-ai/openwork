import { captureBrowserFilm, evaluateOnSurface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

export async function sidebarChrome(seed: Seed) {
  const den = await seed.den({
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    org: { name: "Sidebar studio", admin: { name: "Workspace Owner" } },
  });
  const app = await seed.desktop({ name: "sidebar-chrome", den, as: "admin" });
  const session = await seed.session(app, { title: "Planning notes" });
  // Arrange a background event through the same ingress as provider sync. No
  // credentials or live provider requests are needed to exercise the bell.
  const mac = await seed.evalIn(app, () => {
    window.dispatchEvent(new CustomEvent("openwork-new-providers-available", {
      detail: { providers: [{ id: "sidebar-provider", name: "Example provider", providerId: "sidebar-provider" }], newProviderCount: 1, newModelCount: 0, source: "cloud_sync" },
    }));
    return /Mac/i.test(navigator.platform);
  });
  const film = process.env.OPENWORK_EVAL_FILM_DIR
    ? await captureBrowserFilm(app, process.env.OPENWORK_EVAL_FILM_DIR)
    : null;
  return {
    app, session, modifier: mac ? "Meta" : "Control", mac,
    // Read-only presentation witness. The fixed probe.dom projection does not
    // include computed styles or running Web Animations.
    presentation: () => evaluateOnSurface(app, () => {
      const newSession = document.querySelector('[data-sidebar-new-chat]');
      const panel = document.querySelector('[data-notification-panel]');
      return {
        newSessionBackground: newSession ? getComputedStyle(newSession).backgroundColor : null,
        panelAnimation: panel ? getComputedStyle(panel).animationName : null,
        panelSettled: panel?.getAnimations().every((animation) => animation.playState === "finished") ?? false,
        sidebarTransitions: [...document.querySelectorAll('[data-slot="sidebar-gap"], [data-slot="sidebar-container"]')]
          .map((node) => getComputedStyle(node).transitionProperty),
      };
    }),
    async reducedMotion(value: boolean) {
      await app.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: value ? "reduce" : "no-preference" }] });
    },
    async [Symbol.asyncDispose]() { await film?.stop(); },
  };
}
