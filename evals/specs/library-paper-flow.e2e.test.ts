import { expect } from "vitest";
import { needs, spec, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { libraryPaperFlow } from "../worlds/library.ts";

const test = spec.world(libraryPaperFlow, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"], services: ["den", "mock"],
    nativeReason: "Connector sign-in hands the provider's page to the operating system browser; only the Electron shell captures that hand-off.",
  },
});

const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library Paper flow skipped — needs: ${missingRequirements.join(", ")}`
  : "a member adds a skill, a connector and a plugin to their Library, uses the skill, then shares, edits and deletes it";

test(title, async ({ evidence, world, user, probe, step }) => {
  needs(requirements);
  const signedOutUser = user.on(world.signedOut);
  const signedOutProbe = probe.on(world.signedOut);
  const texts = async (selector: string, on = probe) => (await on.dom(selector)).elements.map((element) => element.text.trim());
  const caption = async (name: string) => (await texts(`[data-library-row="${name}"] [data-library-caption]`))[0] ?? "";
  const sectionMeta = async (section: string) => (await texts(`[data-library-section-meta="${section}"]`))[0] ?? "";
  // Library pages fade in over 300ms; capture them once they have landed.
  const shot = async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await user.screenshot();
  };
  // Toasts stay up while the window is in the background; close each once it has been read.
  const closeToasts = async () => {
    for (let remaining = 6; remaining > 0 && (await probe.dom("[data-undo-toast]")).elements.length > 0; remaining -= 1) {
      await user.click({ role: "button", label: "Close" });
    }
  };
  const rowNames = async (section: string) => (await probe.dom(`[data-library-section="${section}"] [data-library-row]`)).elements.map((element) => element.text);

  // Lane 1 · Browse
  await step("before: signed out, the Library shows what is on this Mac and what signing in unlocks", async () => {
    await signedOutUser.see({ testId: "library-sign-up-banner" }, { timeoutMs: 90_000 });
    await signedOutUser.see({ text: "Sign up to share your skills and connectors with your team." });
    const locked = (await signedOutProbe.dom("[data-library-locked]")).elements.length;
    const lockedSection = await texts('[data-library-section="locked"]', signedOutProbe);
    await signedOutUser.notSee({ role: "tab", label: /Ready to use/ });
    await signedOutUser.screenshot();
    evidence.recordAssertionEvidence(
      "Signed out, the Library says what signing in unlocks instead of an empty page",
      `sign-up banner shown; locked section "${lockedSection[0]?.split("\n")[0] ?? ""}" previews ${locked} connectors; no state tabs`,
      locked >= 3,
    );
    expect(locked).toBeGreaterThanOrEqual(3);
  });

  await step("signed in, one list groups things by where they come from, and connectors that need you say Sign in", async () => {
    await user.see({ role: "button", label: "Add to library" }, { timeoutMs: 90_000 });
    await probe.eventually(async () => (await texts('[data-library-row="Linear"] [data-library-status]')).join(""), {
      within: 60_000, label: "Linear's row arrives from the organization", until: (chip) => chip === "Sign in",
    });
    const filters = await texts('[aria-label="Library filters"] button[aria-pressed]:not([aria-label])');
    expect(filters).toEqual(["All", "Skills", "Plugins"]);
    await user.notSee({ role: "tab", label: /Ready to use/ });
    const chip = async (name: string) => (await texts(`[data-library-row="${name}"] [data-library-status]`)).join("");
    const google = await chip("Google Workspace");
    const linear = await chip("Linear");
    const wikiReady = (await probe.dom('[data-library-row="Team wiki"] [data-library-ready]')).elements.length === 1;
    const openwork = await sectionMeta("openwork");
    await shot();
    evidence.recordAssertionEvidence(
      "One list: connectors from the organization carry their next step",
      `filters=${filters.join(" / ")}; From OpenWork "${openwork}"; Google Workspace chip=${google}; Linear chip=${linear}; Team wiki ready=${wikiReady}`,
      google === "Sign in" && linear === "Sign in" && wikiReady,
    );
    expect(google).toBe("Sign in");
    expect(linear).toBe("Sign in");
    expect(wikiReady).toBe(true);
  });

  await step("opening Google Workspace says who can use it and whose account the AI uses", async () => {
    await user.click({ text: "Google Workspace" });
    await user.see({ text: "Who can use this" });
    await user.see({ text: `Everyone in ${world.orgName}` });
    await user.see({ text: "Your own. You sign in once." });
    await shot();
    evidence.recordAssertionEvidence(
      "A shared connector says who has it and whose account it signs in with",
      `Who can use this → "Everyone in ${world.orgName}"; Whose account does the AI use? → "Your own. You sign in once."`,
      true,
    );
    await user.click({ role: "button", label: "Library" });
    await user.see({ role: "button", label: "Add to library" });
  });

  // Lane 2 · Add
  await step("Add to library asks what to add: a skill, a connector, or a plugin", async () => {
    await user.click({ role: "button", label: "Add to library" });
    await user.see({ testId: "library-add-choices" });
    const kinds = await texts('[data-testid="library-add-choices"] [data-kind-title]');
    await user.see({ text: "New things start just for you. Share them whenever you like." });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(1);
    await shot();
    evidence.recordAssertionEvidence(
      "The picker stays a small dialog with three plain choices",
      `choices=${kinds.join(" / ")}; footer "New things start just for you. Share them whenever you like."`,
      kinds.join("|") === "Skill|Connector|Plugin",
    );
    expect(kinds).toEqual(["Skill", "Connector", "Plugin"]);
  });

  await step("a skill is written in plain words on its own page and starts just for you", async () => {
    await user.click({ text: /^Skill$/ });
    await user.see({ testId: "library-create-page" });
    await user.see({ role: "heading", label: "Create a skill" });
    await user.type({ label: "Name" }, "Customer briefing");
    await user.type({ label: "When should it be used?" }, "A one-page brief before a customer call");
    await user.type({ placeholder: "# Instructions\n\nDescribe the complete workflow..." }, "Find the meeting, read the last emails with the customer, and write a one-page brief.");
    await user.see({ text: "Only you can use it until you share it." });
    await shot();
    await user.click({ role: "button", label: "Create skill" });
    await user.see({ text: "Added to your Library" }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "library-create-page" });
    await user.see({ role: "button", label: "More for Customer briefing" }, { timeoutMs: 60_000 });
    const captionText = await caption("Customer briefing");
    evidence.recordAssertionEvidence(
      "Creating a skill adds it to Added by you, just for the creator",
      `toast "Added to your Library · Only you can use it for now"; row caption "${captionText}"`,
      captionText === "Cloud · You · Just me",
    );
    expect(captionText).toBe("Cloud · You · Just me");
    await closeToasts();
  });

  await step("Connector opens a catalog of services, and Linear shows as already added", async () => {
    await user.click({ role: "button", label: "Add to library" });
    await user.click({ text: /^Connector$/ });
    await user.see({ role: "heading", label: "Add a connector" });
    const listed = (await probe.dom("[data-connector]")).elements.map((element) => element.text.split("\n")[0]?.trim() ?? "");
    const linear = await texts('[data-connector="Linear"]');
    await user.see({ text: "Add an MCP server with the address your vendor or IT team gave you." });
    await shot();
    evidence.recordAssertionEvidence(
      "The catalog lists services by name and marks the one the organization already has",
      `connectors=${listed.join(" / ")}; Linear row "${linear[0]?.replace(/\s+/g, " ") ?? ""}"; Something else · Add an MCP`,
      Boolean(linear[0]?.includes("Added")),
    );
    expect(linear[0]).toContain("Added");
    expect((await probe.dom('[data-connector="Slack"] button')).elements.map((element) => element.text)).toEqual(["Add"]);
  });

  await step("Set up Slack says what the AI can do and that you sign in with your own Slack", async () => {
    await user.click({ role: "button", label: "Add Slack" });
    await user.see({ role: "heading", label: "Set up Slack" });
    await user.see({ text: "What your AI can do" });
    await user.see({ text: "You sign in with your own Slack next. OpenWork only sees what you can see." });
    await user.see({ role: "button", label: "Sign in with Slack" });
    await shot();
    evidence.recordAssertionEvidence(
      "Setting up a connector explains the access in plain words before sign-in",
      "\"What your AI can do\" → read what you can already see, act as you only when you ask; note \"You sign in with your own Slack next. OpenWork only sees what you can see.\"; button \"Sign in with Slack\"",
      true,
    );
  });

  await step("Sign in with Slack adds it and opens Slack's own sign-in page in the browser", async () => {
    const before = await world.browserUrls.opened();
    await user.click({ role: "button", label: "Sign in with Slack" });
    const opened = await probe.eventually(() => world.browserUrls.opened(), {
      within: 60_000, label: "the desktop opens the connector's sign-in page",
      until: (urls) => urls.length > before.length,
    });
    const url = new URL(opened.at(-1) ?? "");
    await user.see({ text: "Added to your Library" });
    await user.see({ role: "button", label: "More for Slack" }, { timeoutMs: 60_000 });
    const slackCaption = await caption("Slack");
    const slackChip = await probe.eventually(async () => (await texts('[data-library-row="Slack"] [data-library-status]')).join(""), {
      within: 30_000, label: "Slack's row asks the member to finish signing in",
      until: (chip) => chip === "Sign in",
    });
    await shot();
    evidence.recordAssertionEvidence(
      "Sign in happens on the service's own page, not inside OpenWork",
      `opened ${url.origin}${url.pathname} (the Slack fixture's authorize page, client_id=${url.searchParams.get("client_id") ? "set" : "missing"}); Slack row caption "${slackCaption}", chip "${slackChip}"`,
      url.origin === world.slackOrigin && url.pathname.endsWith("/authorize") && slackChip === "Sign in",
    );
    expect(url.origin).toBe(world.slackOrigin);
    expect(url.pathname).toMatch(/\/authorize$/);
    expect(slackCaption).toBe("Cloud · You · Just me");
    expect(slackChip).toBe("Sign in");
    await closeToasts();
  });

  await step("Something else opens Add an MCP server with three ways to sign in", async () => {
    await user.click({ role: "button", label: "Add to library" });
    await user.click({ text: /^Connector$/ });
    await user.click({ role: "button", label: "Add an MCP" });
    await user.see({ role: "heading", label: "Add an MCP server" });
    const ways = await texts('[role="radiogroup"][aria-label="How does it sign in?"] [role="radio"] span > span:first-child');
    await user.see({ role: "button", label: "Add and sign in" });
    await shot();
    evidence.recordAssertionEvidence(
      "An MCP of your own asks only how it signs in",
      `ways=${ways.join(" / ")}; primary button "Add and sign in"`,
      ways.join("|") === "With my account|With a key|No sign-in",
    );
    expect(ways).toEqual(["With my account", "With a key", "No sign-in"]);
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ testId: "library-create-page" });
  });

  await step("a plugin bundles a skill and a command on one page", async () => {
    await user.click({ role: "button", label: "Add to library" });
    await user.click({ text: /^Plugin$/ });
    await user.see({ role: "heading", label: "Create a plugin" });
    await user.type({ label: "Plugin name" }, "Sales call prep");
    await user.type({ label: "Description" }, "A skill and a command for sales calls");
    await user.click({ role: "button", label: "Skill" });
    await user.type({ label: "Skill name" }, "call-notes");
    await user.type({ label: "When should it be used?" }, "After a sales call");
    await user.type({ label: "What should it do?" }, "Turn the call into three next steps.");
    await user.click({ role: "button", label: "Command" });
    await user.type({ label: "Command name" }, "prep");
    await user.type({ label: "When should it be used?", nth: 1 }, "Before a sales call");
    await user.type({ label: "What should it do?", nth: 1 }, "List what to ask the customer.");
    const parts = await texts("[data-plugin-component]");
    await shot();
    await user.click({ role: "button", label: "Create plugin" });
    await user.see({ role: "button", label: "More for Sales call prep" }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "library-create-page" });
    evidence.recordAssertionEvidence(
      "A plugin is made of the parts the member adds, on one page",
      `inside: ${parts.map((part) => part.split("\n")[0]).join(" / ")}; created "Sales call prep"`,
      parts.length === 2,
    );
    expect(parts).toHaveLength(2);
  });

  await step("after: three things added by you, each just for you, with Share… in the toast", async () => {
    await user.see({ text: "Share…" });
    const mine = await rowNames("mine");
    const captions = await Promise.all(["Customer briefing", "Slack", "Sales call prep"].map(caption));
    const meta = await sectionMeta("mine");
    await shot();
    evidence.recordAssertionEvidence(
      "Everything new starts just for its creator",
      `Added by you "${meta}": ${["Customer briefing", "Slack", "Sales call prep"].map((name, index) => `${name} → ${captions[index]}`).join("; ")}`,
      meta === "3 · only you so far" && captions.every((value) => value === "Cloud · You · Just me"),
    );
    expect(mine).toHaveLength(3);
    expect(meta).toBe("3 · only you so far");
    expect(captions).toEqual(["Cloud · You · Just me", "Cloud · You · Just me", "Cloud · You · Just me"]);
    await closeToasts();
  });

  // Lane 3 · Use
  await step("a new task uses the customer-briefing skill and the answer says so", async () => {
    await user.click({ role: "button", label: "New session" });
    await user.type("composer", world.prompt);
    await user.press("Enter");
    await user.see({ text: world.prompt }, { timeoutMs: 30_000 });
    await user.see({ text: /your customer-briefing skill/ }, { timeoutMs: 120_000 });
    await user.see({ text: "Here is a one-page brief for your 10:00 customer meeting." }, { timeoutMs: 60_000 });
    expect(world.prompt).not.toContain("customer-briefing");
    const line = (await probe.text()).match(/Us(?:ing|ed) your customer-briefing skill/)?.[0] ?? "";
    await shot();
    evidence.recordAssertionEvidence(
      "The answer names the skill it used, although the request never mentioned it",
      `request "${world.prompt}"; activity line "${line}"`,
      line.length > 0,
    );
    expect(line).not.toBe("");
    await user.click({ role: "button", label: "Library" });
    await user.see({ role: "button", label: "More for Customer briefing" }, { timeoutMs: 60_000 });
  });

  // Lane 4 · Share
  await step("⋯ on Customer briefing offers Open, Edit, Share, Duplicate and Delete", async () => {
    await user.click({ role: "button", label: "More for Customer briefing" });
    await user.see({ role: "menuitem", label: "Open" });
    const items = await texts('[role="menuitem"]');
    await shot();
    evidence.recordAssertionEvidence(
      "Everything a creator can do with their skill is one click away",
      `menu: ${items.join(" / ")}`,
      items.join("|") === "Open|Edit|Share…|Duplicate|Delete…",
    );
    expect(items).toEqual(["Open", "Edit", "Share…", "Duplicate", "Delete…"]);
  });

  await step("the Share page asks who can use it, and adding Support counts the people", async () => {
    await user.click({ role: "menuitem", label: "Share…" });
    await user.see({ testId: "library-share-page" });
    await user.see({ text: "Who can use it" });
    await user.see({ text: "Sam K. (you)" });
    await user.see({ role: "switch", label: "Everyone in the organization" });
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "menuitem", label: "Support" });
    await user.see({ text: `${world.supportSize} people, and anyone who joins Support later` });
    await user.see({ role: "button", label: "Share with Support" });
    await shot();
    evidence.recordAssertionEvidence(
      "Sharing names the team and how many people get it before anything changes",
      `rows: Everyone toggle, Sam K. (you) · Owner, Support · "${world.supportSize} people, and anyone who joins Support later"; button "Share with Support"`,
      true,
    );
  });

  await step("after sharing: the row says Shared with Support, and the toast says how many people have it", async () => {
    await user.click({ role: "button", label: "Share with Support" });
    await user.see({ text: "Customer briefing shared with Support" }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "library-share-page" });
    await user.see({ text: `${world.supportSize} people have it in their Library now` });
    const captionText = await probe.eventually(() => caption("Customer briefing"), {
      within: 30_000, label: "the shared row caption", until: (value) => value === "Cloud · You · Shared with Support",
    });
    const meta = await sectionMeta("mine");
    await shot();
    evidence.recordAssertionEvidence(
      "The Library says who has it now",
      `row caption "${captionText}"; Added by you "${meta}"; toast "Customer briefing shared with Support · ${world.supportSize} people have it in their Library now · Undo"`,
      meta === "1 shared with Support",
    );
    expect(meta).toBe("1 shared with Support");
    await closeToasts();
  });

  await step("Alex in Support now has Customer briefing in their Library", async () => {
    const alex = user.on(world.alexApp);
    const alexProbe = probe.on(world.alexApp);
    await alex.see({ role: "button", label: "Refresh" }, { timeoutMs: 90_000 });
    const alexCaption = await alexProbe.eventually(async () => {
      const current = (await texts('[data-library-row="Customer briefing"] [data-library-caption]', alexProbe))[0] ?? "";
      if (!current.includes("Support")) await alex.click({ role: "button", label: "Refresh" });
      return current;
    }, { within: 60_000, label: "Customer briefing arrives in Alex's Library through Support", until: (value) => value.includes("Support") });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await alex.screenshot();
    const library = await probe.api(world.alex, "/v1/me/library", { headers: { "x-openwork-org-id": world.organizationId } });
    const body: unknown = library.body;
    const items = typeof body === "object" && body !== null && "items" in body && Array.isArray(body.items) ? body.items : [];
    const item: unknown = items.find((entry: unknown) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === "Customer briefing");
    const edges = typeof item === "object" && item !== null && "edges" in item && Array.isArray(item.edges) ? item.edges : [];
    const viaSupport = edges.some((edge: unknown) => JSON.stringify(edge).includes("\"Support\""));
    evidence.recordAssertionEvidence(
      "A member of Support gets it without doing anything",
      `Alex's Library (HTTP ${library.response.status}) lists Customer briefing: ${item ? "yes" : "no"}; reached through the Support team: ${viaSupport}; row caption on Alex's desktop "${alexCaption}"`,
      Boolean(item) && viaSupport && alexCaption.includes("Support"),
    );
    expect(item).toBeTruthy();
    expect(viaSupport).toBe(true);
    expect(alexCaption).toContain("Support");
  });

  // Lane 5 · Edit
  await step("the menu now offers Stop sharing, and Edit warns that Support has this skill", async () => {
    await user.click({ role: "button", label: "More for Customer briefing" });
    await user.see({ role: "menuitem", label: "Stop sharing" }, { timeoutMs: 30_000 });
    const items = await texts('[role="menuitem"]');
    expect(items).toContain("Stop sharing");
    await user.click({ role: "menuitem", label: "Edit" });
    await user.see({ role: "heading", label: "Edit Customer briefing" }, { timeoutMs: 30_000 });
    await user.see({ testId: "library-edit-shared-note" });
    await user.see({ text: `Support has this skill (${world.supportSize} people)` });
    await user.see({ role: "button", label: "Save a copy just for me" });
    await user.type({ label: "When should it be used?" }, " or a renewal", { replace: false });
    await shot();
    evidence.recordAssertionEvidence(
      "Editing something shared says who else gets the change and offers a private copy",
      `menu: ${items.join(" / ")}; note "Support has this skill (${world.supportSize} people)"; "Save a copy just for me"; primary "Save for everyone"`,
      items.includes("Stop sharing"),
    );
  });

  await step("Save for everyone: the row says Changed just now and Support has it", async () => {
    await user.click({ role: "button", label: "Save for everyone" });
    await user.see({ text: "Customer briefing saved" }, { timeoutMs: 30_000 });
    await user.see({ text: "Support gets the new version in their next task" });
    const captionText = await probe.eventually(() => caption("Customer briefing"), {
      within: 30_000, label: "the edited row caption", until: (value) => value === "Changed just now · Support has it",
    });
    await shot();
    evidence.recordAssertionEvidence(
      "The Library says the change reached the team",
      `row caption "${captionText}"; toast "Customer briefing saved · Support gets the new version in their next task · Undo"`,
      captionText === "Changed just now · Support has it",
    );
    await closeToasts();
  });

  // Lane 6 · Delete
  await step("Delete names who else loses it and offers to stop sharing instead", async () => {
    await user.click({ role: "button", label: "More for Customer briefing" });
    await user.click({ role: "menuitem", label: "Delete…" });
    await user.see({ testId: "library-delete-dialog" });
    await user.see({ text: `It leaves your Library and Support's Library (${world.supportSize} people). Tasks that already used it keep their results.` });
    await user.see({ role: "button", label: "stop sharing instead" });
    await shot();
    evidence.recordAssertionEvidence(
      "Deleting something shared says exactly who loses it",
      `"Delete Customer briefing?" — "It leaves your Library and Support's Library (${world.supportSize} people)…"; "Only want Support to lose it? Keep it for yourself and stop sharing instead"`,
      true,
    );
  });

  await step("after delete: the row is gone, two things remain just for you, and the toast offers Undo", async () => {
    await user.click({ role: "button", label: "Delete" });
    await user.see({ text: "Customer briefing deleted" }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "library-delete-dialog" });
    await user.see({ text: "Support no longer has it" });
    await user.see({ role: "button", label: "Undo" });
    const meta = await probe.eventually(() => sectionMeta("mine"), {
      within: 30_000, label: "Added by you after delete", until: (value) => value === "2 · only you so far",
    });
    const mine = await rowNames("mine");
    const anywhere = (await probe.dom('[data-library-row="Customer briefing"]')).elements.length;
    await shot();
    evidence.recordAssertionEvidence(
      "Delete removes it for everyone who had it, with a moment to undo",
      `Added by you "${meta}": ${mine.map((name) => name.split("\n")[0]).join(" / ")}; Customer briefing rows left in the Library: ${anywhere}; toast "Customer briefing deleted · Support no longer has it · Undo"`,
      meta === "2 · only you so far" && anywhere === 0,
    );
    expect(anywhere).toBe(0);
  });
});
