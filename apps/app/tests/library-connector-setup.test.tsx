/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { DenExternalMcpPreset } from "../src/app/lib/den";
import { denConnectorSetupUrl } from "../src/app/lib/den-dashboard-links";
import {
  catalogConnectionNeedsSignIn,
  connectorNeedsOrganizationApp,
  LibraryConnectorCatalogPage,
  LibraryConnectorSetupPage,
  type LibraryConnectorSetupInput,
} from "../src/react-app/domains/settings/pages/library-connector-pages";

let createRoot: typeof import("react-dom/client")["createRoot"];
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  createRoot = (await import("react-dom/client")).createRoot;
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
let root: Root | null = null;
let previousAct: unknown;
beforeEach(() => { previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
});

const orgAppPreset: DenExternalMcpPreset = {
  presetId: "acme-chat",
  displayName: "Acme Chat",
  description: "Channels, DMs, and search. An admin configures its OAuth client once.",
  url: "https://mcp.acme.test/mcp",
  authType: "oauth",
  requiresOAuthClient: true,
};

const ownAppPreset: DenExternalMcpPreset = {
  ...orgAppPreset,
  presetId: "acme-deploy",
  displayName: "Acme Deploy",
  url: "https://mcp.deploy.acme.test/mcp",
  defaultOAuthClientId: "openwork",
};

type Rendered = { submitted: LibraryConnectorSetupInput[]; openedCloud: number };

async function render(preset: DenExternalMcpPreset, options: { admin: boolean; cloud?: boolean }): Promise<Rendered> {
  const rendered: Rendered = { submitted: [], openedCloud: 0 };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <LibraryConnectorSetupPage
        preset={preset}
        canSetUpOrganizationApp={options.admin}
        onSetUpInCloud={options.cloud === false ? undefined : () => { rendered.openedCloud += 1; }}
        onBack={() => undefined}
        onCatalog={() => undefined}
        onSubmit={async (input) => { rendered.submitted.push(input); }}
      />,
    );
  });
  return rendered;
}

function buttons() {
  return [...document.querySelectorAll("button")];
}

function button(label: string) {
  const found = buttons().find((element) => element.textContent?.includes(label));
  if (!found) throw new Error(`No button "${label}" in: ${buttons().map((element) => element.textContent).join(" | ")}`);
  return found;
}

const page = () => document.body.textContent ?? "";

test("only an OAuth preset without OpenWork's own app needs the organization's app", () => {
  expect(connectorNeedsOrganizationApp(orgAppPreset)).toBe(true);
  expect(connectorNeedsOrganizationApp(ownAppPreset)).toBe(false);
  expect(connectorNeedsOrganizationApp({ authType: "oauth" })).toBe(false);
  expect(connectorNeedsOrganizationApp({ authType: "apikey", requiresOAuthClient: true })).toBe(false);
});

test("a member sees the connector locked, with who can set it up, and no app codes", async () => {
  const rendered = await render(orgAppPreset, { admin: false });
  expect(page()).toContain("Not set up for your organization");
  expect(page()).toContain("An admin adds your organization's Acme Chat app in OpenWork Cloud. Then you sign in with your own Acme Chat account.");
  expect(page()).not.toContain("{name}");
  expect(page()).not.toContain("Client ID");
  expect(page()).not.toContain("Client secret");
  expect(document.querySelectorAll("input")).toHaveLength(0);
  expect(document.querySelector("[data-testid=library-connector-note]")?.getAttribute("data-state")).toBe("locked");

  const locked = document.querySelector<HTMLButtonElement>("[data-testid=library-connector-locked]");
  expect(locked?.textContent).toContain("Sign in with Acme Chat");
  expect(locked?.textContent).toContain("An admin sets up Acme Chat for your organization first.");
  expect(locked?.getAttribute("aria-disabled") === "true" || locked?.disabled === true).toBe(true);
  // Blocked is neutral, not an error (C5).
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(document.body.innerHTML).not.toContain("text-red-11");
  expect(page()).not.toContain("Set up in OpenWork Cloud");

  await act(async () => locked?.click());
  expect(rendered.submitted).toEqual([]);
  expect(button("Cancel").disabled).toBe(false);
});

test("an admin is sent to OpenWork Cloud to add the organization's app", async () => {
  const rendered = await render(orgAppPreset, { admin: true });
  expect(page()).toContain("Not set up for your organization");
  expect(page()).toContain("Add your organization's Acme Chat app once in OpenWork Cloud. Then everyone signs in with their own Acme Chat account.");
  expect(page()).not.toContain("Client ID");
  expect(document.querySelectorAll("input")).toHaveLength(0);
  expect(document.querySelector("[data-testid=library-connector-note]")?.getAttribute("data-state")).toBe("needs-setup");
  expect(page()).not.toContain("Sign in with Acme Chat");

  await act(async () => button("Set up in OpenWork Cloud").click());
  expect(rendered.openedCloud).toBe(1);
  expect(rendered.submitted).toEqual([]);
});

test("an admin without a Cloud address cannot open setup", async () => {
  await render(orgAppPreset, { admin: true, cloud: false });
  expect(button("Set up in OpenWork Cloud").disabled).toBe(true);
});

test("a preset with OpenWork's own app is a plain sign-in for everyone", async () => {
  for (const admin of [false, true]) {
    const rendered = await render(ownAppPreset, { admin });
    expect(page()).toContain("You sign in with your own Acme Deploy next.");
    expect(page()).not.toContain("Not set up for your organization");
    expect(page()).not.toContain("Client ID");
    await act(async () => button("Sign in with Acme Deploy").click());
    expect(rendered.submitted).toEqual([{}]);
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  }
});

test("the admin setup link opens Den's connector setup for that preset", () => {
  expect(denConnectorSetupUrl("https://den.example.test", "slack")).toBe("https://den.example.test/dashboard/mcp-connections/new/slack");
  expect(denConnectorSetupUrl("https://den.example.test/", "a b")).toBe("https://den.example.test/dashboard/mcp-connections/new/a%20b");
  expect(denConnectorSetupUrl("", "slack")).toBeNull();
  expect(denConnectorSetupUrl("https://den.example.test", " ")).toBeNull();
});

const perMember = { authType: "oauth" as const, credentialMode: "per_member" as const, connected: true, connectedForMe: false };

test("only a personal sign-in the member has not finished is offered from the catalog", () => {
  expect(catalogConnectionNeedsSignIn(perMember)).toBe(true);
  expect(catalogConnectionNeedsSignIn({ ...perMember, connectedForMe: true })).toBe(false);
  expect(catalogConnectionNeedsSignIn({ ...perMember, connectedForMe: true, needsReconnect: true })).toBe(true);
  expect(catalogConnectionNeedsSignIn({ ...perMember, credentialMode: "shared" })).toBe(false);
  expect(catalogConnectionNeedsSignIn({ ...perMember, authType: "apikey" })).toBe(false);
  expect(catalogConnectionNeedsSignIn({ ...perMember, authType: "none" })).toBe(false);
});

test("a connector the organization already has signs the member in from the catalog in one click", async () => {
  const sharedPreset: DenExternalMcpPreset = { ...ownAppPreset, presetId: "acme-wiki", displayName: "Acme Wiki", url: "https://mcp.wiki.acme.test/mcp" };
  const signedInPreset: DenExternalMcpPreset = { ...ownAppPreset, presetId: "acme-notes", displayName: "Acme Notes", url: "https://mcp.notes.acme.test/mcp" };
  const signIns: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <LibraryConnectorCatalogPage
        presets={[orgAppPreset, sharedPreset, signedInPreset, ownAppPreset]}
        addedUrls={new Set([orgAppPreset.url, sharedPreset.url, signedInPreset.url])}
        signInsByUrl={new Map([[orgAppPreset.url, { onSignIn: () => signIns.push("emc_chat"), busy: false }]])}
        onBack={() => undefined}
        onPick={() => undefined}
        onSomethingElse={() => undefined}
      />,
    );
  });
  const row = (name: string) => document.querySelector(`[data-connector="${name}"]`)?.textContent ?? "";
  expect(row("Acme Chat")).toContain("Sign in with Acme Chat");
  expect(row("Acme Chat")).not.toContain("Added");
  expect(row("Acme Wiki")).toContain("Added");
  expect(row("Acme Notes")).toContain("Added");
  expect(row("Acme Deploy")).toContain("Add");
  expect(row("Acme Deploy")).not.toContain("Sign in");

  await act(async () => button("Sign in with Acme Chat").click());
  expect(signIns).toEqual(["emc_chat"]);
});

test("a catalog connector blocked by a setting in the service's app says why and links to its settings", async () => {
  const opened: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <LibraryConnectorCatalogPage
        presets={[orgAppPreset]}
        addedUrls={new Set([orgAppPreset.url])}
        signInsByUrl={new Map([[orgAppPreset.url, {
          onSignIn: () => undefined,
          busy: false,
          problem: { reason: "The service needs a setting changed before it can connect.", settings: { url: "https://api.slack.com/apps/A123", label: "Open Slack app settings" } },
          onOpenSettings: (url) => opened.push(url),
        }]])}
        onBack={() => undefined}
        onPick={() => undefined}
        onSomethingElse={() => undefined}
      />,
    );
  });
  const row = document.querySelector("[data-connector=\"Acme Chat\"]")?.textContent ?? "";
  expect(row).toContain("The service needs a setting changed before it can connect.");
  expect(row).not.toContain("Sign in with Acme Chat");
  await act(async () => button("Open Slack app settings").click());
  expect(opened).toEqual(["https://api.slack.com/apps/A123"]);
});
