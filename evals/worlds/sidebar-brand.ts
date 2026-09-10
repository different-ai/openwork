import { createAndSelectWorkspace, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { browserScript, type Place, type Surface } from "@openwork/testkit";

export async function setSidebarBrandTheme(app: Surface, dark: boolean) {
  const theme = dark ? "dark" : "light";
  await app.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await waitFor(app, browserScript(theme => document.documentElement.dataset.theme === theme
    && getComputedStyle(document.documentElement).colorScheme === theme, [theme]), { timeoutMs: 5_000 });
}

export async function sidebarBrandApp(place: Place) {
  const app = await desktop({ name: "sidebar-brand-geometry", host: place.host() });
  try {
    if (!app.workspaceRoot) throw new Error("Expected an isolated spawned app");
    await createAndSelectWorkspace(app, { path: `${app.workspaceRoot}/evals-tmp/sidebar-brand-${Date.now()}` });
    return app;
  } catch (error) {
    await app.stop();
    throw error;
  }
}
