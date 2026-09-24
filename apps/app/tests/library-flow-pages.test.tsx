/** @jsxImportSource react */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

import type { DenExternalMcpPreset } from "../src/app/lib/den";
import type { DenLibraryOrgDirectory } from "../src/app/lib/den-library";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { AlertDialog, AlertDialogContent, AlertDialogTitle } = await import("../src/components/ui/alert-dialog");
const { LibrarySharePage } = await import("../src/react-app/domains/settings/pages/library-share-page");
const { LibraryEditSkillPage } = await import("../src/react-app/domains/settings/pages/library-edit-skill-page");
const { LibraryDeleteDialog } = await import("../src/react-app/domains/settings/pages/library-delete-dialog");
const { LibraryConnectorCatalogPage, LibraryConnectorSetupPage } = await import("../src/react-app/domains/settings/pages/library-connector-pages");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}

function buttonNamed(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

// See library-add-kind-picker.test.tsx: Base UI dialogs cannot mount when
// another file loaded it before a DOM existed, so skip loudly on file order.
async function dialogLayerCanOpen() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <AlertDialog open>
      <AlertDialogContent><AlertDialogTitle>alert-probe</AlertDialogTitle></AlertDialogContent>
    </AlertDialog>,
  ));
  const opened = document.body.textContent?.includes("alert-probe") === true;
  await act(async () => root.unmount());
  host.remove();
  return opened;
}
const dialogLayerInert = !(await dialogLayerCanOpen());

const directory: DenLibraryOrgDirectory = {
  currentMemberId: "member-owner",
  members: [
    { id: "member-owner", name: "Sam K.", email: null },
    { id: "member-a", name: "Alex", email: null },
  ],
  teams: [{ id: "team-support", name: "Support", memberIds: ["member-a", "m2", "m3", "m4", "m5"] }],
};
const support = { orgWide: false, teams: [{ id: "team-support", name: "Support", peopleCount: 5, grantId: "g1" }], people: [] };

const slack: DenExternalMcpPreset = {
  presetId: "slack",
  displayName: "Slack",
  description: "Messages and channels. Admin detail follows.",
  url: "https://mcp.slack.com/mcp",
  authType: "oauth",
};

describe("Share page", () => {
  test("names who can use it and saves exactly that audience", async () => {
    const onSave = mock(async () => {});
    const host = await mount(
      <LibrarySharePage
        name="Customer briefing"
        description="A one-page brief before a customer call"
        taxonomy="skill"
        icon={null}
        directory={directory}
        initialAudience={support}
        canShareOrgWide
        onCancel={() => {}}
        onSave={onSave}
      />,
    );
    expect(host.querySelector("h1")?.textContent).toBe("Customer briefing");
    expect(host.textContent).toContain("Who can use it");
    expect(host.textContent).toContain("Sam K. (you)");
    expect(host.textContent).toContain("5 people, and anyone who joins Support later");
    expect(host.textContent).toContain("Support will see it in their Library.");
    const share = buttonNamed(host, "Share with Support");
    // Unchanged, so there is nothing to save yet.
    expect(share?.disabled).toBe(true);

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove Support"]')?.click());
    const stop = buttonNamed(host, "Stop sharing");
    expect(stop?.disabled).toBe(false);
    await act(async () => stop?.click());
    expect(onSave).toHaveBeenCalledWith([], { orgWide: false, teams: [], people: [] });
  });
});

describe("Edit page", () => {
  const skill = {
    pluginId: "plugin-1",
    configObjectId: "co-1",
    slug: "customer-briefing",
    name: "Customer briefing",
    description: "Before a customer call",
    instructions: "Read my calendar.",
    rawSourceText: "",
  };

  test("warns that saving changes it for the people who have it, and offers a private copy", async () => {
    const onSave = mock(async () => {});
    const onSaveCopy = mock(async () => {});
    const host = await mount(
      <LibraryEditSkillPage skill={skill} audienceName="Support" audiencePeople={5} onCancel={() => {}} onSave={onSave} onSaveCopy={onSaveCopy} />,
    );
    expect(host.querySelector("h1")?.textContent).toBe("Edit Customer briefing");
    expect(host.querySelector('[data-testid="library-edit-shared-note"]')?.textContent).toContain("Support has this skill (5 people)");
    expect(host.textContent).toContain("You can undo for a few seconds.");
    // Nothing changed yet, so there is nothing to save for everyone.
    expect(buttonNamed(host, "Save for everyone")?.disabled).toBe(true);
    await act(async () => buttonNamed(host, "Save a copy just for me")?.click());
    expect(onSaveCopy).toHaveBeenCalledWith({ name: "Customer briefing", description: "Before a customer call", instructions: "Read my calendar." });
    expect(onSave).not.toHaveBeenCalled();
  });

  test("only the member has it: a plain Save and no warning", async () => {
    const host = await mount(
      <LibraryEditSkillPage skill={skill} audienceName={null} audiencePeople={0} onCancel={() => {}} onSave={async () => {}} onSaveCopy={async () => {}} />,
    );
    expect(host.querySelector('[data-testid="library-edit-shared-note"]')).toBeNull();
    expect(buttonNamed(host, "Save")).not.toBeUndefined();
  });
});

describe("Delete dialog", () => {
  test.skipIf(dialogLayerInert)("names who else loses it and offers Stop sharing instead", async () => {
    const onDelete = mock(() => {});
    const onStop = mock(() => {});
    await mount(
      <LibraryDeleteDialog open name="Customer briefing" audienceName="Support" audiencePeople={5} onCancel={() => {}} onDelete={onDelete} onStopSharing={onStop} />,
    );
    const dialog = document.querySelector<HTMLElement>('[data-testid="library-delete-dialog"]');
    expect(dialog?.textContent).toContain("Delete Customer briefing?");
    expect(dialog?.textContent).toContain("It leaves your Library and Support's Library (5 people).");
    expect(dialog?.textContent).toContain("Only want Support to lose it?");
    await act(async () => buttonNamed(document, "stop sharing instead")?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => buttonNamed(document, "Delete")?.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("Connector pages", () => {
  test("the catalog marks what is already added and keeps a way to add any MCP", async () => {
    const onPick = mock(() => {});
    const onElse = mock(() => {});
    const linear: DenExternalMcpPreset = { presetId: "linear", displayName: "Linear", description: "Issues and projects.", url: "https://mcp.linear.app/mcp", authType: "apikey" };
    const host = await mount(
      <LibraryConnectorCatalogPage presets={[slack, linear]} addedUrls={new Set([linear.url])} onBack={() => {}} onPick={onPick} onSomethingElse={onElse} />,
    );
    expect(host.querySelector("h1")?.textContent).toBe("Add a connector");
    expect(host.querySelector('[data-connector="Linear"]')?.textContent).toContain("Added");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Add Slack"]')?.click());
    expect(onPick).toHaveBeenCalledWith(slack);
    await act(async () => buttonNamed(host, "Add an MCP")?.click());
    expect(onElse).toHaveBeenCalledTimes(1);
  });

  test("setup says the member signs in next with their own account", async () => {
    const onSubmit = mock(async () => {});
    const host = await mount(<LibraryConnectorSetupPage preset={slack} onBack={() => {}} onCatalog={() => {}} onSubmit={onSubmit} />);
    expect(host.querySelector("h1")?.textContent).toBe("Set up Slack");
    expect(host.textContent).toContain("What your AI can do");
    expect(host.querySelector('[data-testid="library-connector-note"]')?.textContent).toContain("You sign in with your own Slack next.");
    await act(async () => buttonNamed(host, "Sign in with Slack")?.click());
    expect(onSubmit).toHaveBeenCalledWith({});
  });
});
