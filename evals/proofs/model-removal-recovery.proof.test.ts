import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { modelRemovalRecovery } from "../worlds/model-removal-recovery.ts";

const test = spec.world(modelRemovalRecovery, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { commands: ["bun"] },
});

// Native HTTP catalog and Den inventory faults cross the real adapter and
// confirmation hook. The world never sets renderer selections or recovery notes.
test("a member keeps their model during a catalog gap and recovers to the closest Claude only after their organization removes it", async ({ world, user, probe, step, evidence }) => {
  const selected = async () => (await probe.dom('button[aria-label="Change model"]')).elements.map(element => element.text).join(" ");
  const note = async () => (await probe.dom('[data-testid="model-recovery-note"]')).elements.map(element => element.text).join(" ");
  async function openConversation(title: string, sessionId: string) {
    await user.click({ text: title });
    await probe.eventually(() => probe.hash(), { within: 15_000, label: `the ${title} conversation`, until: value => value.includes(sessionId) });
  }
  async function chooseSavedModel(title: string, sessionId: string) {
    await openConversation(title, sessionId);
    await user.click("Change model");
    await user.see({ testId: "composer-model-picker" });
    try {
      await user.click({ testId: `model-option-${world.providerID}-${world.old.id}` });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; native HTTP witnesses=${JSON.stringify(world.reads())}`);
    }
    await probe.eventually(selected, { within: 15_000, label: "the saved Claude selection", until: value => value.includes(world.old.name) });
  }
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("before: two conversations remember Claude Opus while Luna is pinned above the other models", async () => {
    await user.reload();
    await chooseSavedModel("Independent planning", world.second.sessionId);
    await chooseSavedModel("Report planning", world.first.sessionId);
    await user.click("Change model");
    const rows = (await probe.dom('[data-testid="composer-model-picker"] [data-model-key]')).elements;
    expect(rows[0]?.text).toContain("GPT-6 Luna");
    expect(rows.some(row => row.text.includes(world.replacement.name))).toBe(true);
    expect(rows.some(row => row.text.includes("Claude Haiku"))).toBe(true);
    evidence.recordAssertionEvidence("The member explicitly chooses Opus even though Luna is pinned first", `selected=${await selected()}; picker order=${rows.map(row => row.text).join(" | ")}`, rows[0]?.text.includes("GPT-6 Luna") === true);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("a missing engine model is not an organization removal while both Den inventories still grant access", async () => {
    world.scenario("catalog-gap");
    await user.reload();
    await user.see("composer", { editable: true });
    const observed = await probe.eventually(async () => ({
      reads: world.reads().filter(read => read.scenario === "catalog-gap"),
      selected: await selected(),
    }), {
      within: 30_000, label: "the member keeps Opus while the missing catalog is checked independently",
      // A regressing build must fail on the person's changed model, not merely
      // time out because it never made the new confirmation reads.
      until: value => /Luna|Sonnet|Haiku/.test(value.selected)
        || (value.reads.filter(read => read.kind === "legacy").length >= 2
          && value.reads.filter(read => read.kind === "gateway").length >= 2
          && value.reads.filter(read => read.kind === "engine").length >= 2),
    });
    expect(observed.selected).toContain(world.old.name);
    const reads = observed.reads;
    expect(reads.filter(read => read.kind === "legacy").every(read => read.oldPresent)).toBe(true);
    expect(reads.filter(read => read.kind === "engine").every(read => !read.oldPresent)).toBe(true);
    expect(await selected()).toContain(world.old.name);
    await user.notSee({ testId: "model-recovery-note" });
    await user.notSee({ testId: "composer-model-picker" });
    evidence.recordAssertionEvidence("The catalog gap is witnessed but the member keeps Opus without an interruption", `native missing reads=${reads.filter(read => read.kind === "engine").length}; Den legacy grant reads=${reads.filter(read => read.kind === "legacy").length}; gateway reads=${reads.filter(read => read.kind === "gateway").length}; selected=${await selected()}; no change note or modal`, (await selected()).includes(world.old.name));
    await user.screenshot();
  });

  await step("after: confirmed removal chooses Sonnet before pinned Luna or Haiku and explains the change inline", async () => {
    world.scenario("removed");
    await user.reload();
    await user.see({ testId: "model-recovery-note" }, { timeoutMs: 45_000 });
    const reads = world.reads().filter(read => read.scenario === "removed");
    const legacy = reads.filter(read => read.kind === "legacy");
    const gateways = reads.filter(read => read.kind === "gateway");
    const first = legacy[0];
    const last = legacy.at(-1);
    const elapsed = first && last ? last.at - first.at : 0;
    const refetch = first && last && reads.some(read => read.kind === "engine" && read.at > first.at && read.at <= last.at);
    expect(legacy.length).toBeGreaterThanOrEqual(2);
    expect(gateways.length).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    expect(refetch).toBe(true);
    expect(legacy.every(read => !read.oldPresent)).toBe(true);
    expect(await selected()).toContain(world.replacement.name);
    expect(await selected()).not.toContain("Luna");
    expect(await note()).toContain(`${world.old.name} was removed by your organization · Using ${world.replacement.name} for this chat ·`);
    await user.see({ role: "button", label: /^Change$/ });
    await user.notSee({ testId: "composer-model-picker" });
    evidence.recordAssertionEvidence("Two complete Den inventories and an intervening native refetch justify the same-family replacement", `legacy absent reads=${legacy.length}; usable gateway reads=${gateways.length}; separation=${elapsed}ms; intervening engine refetch=${refetch}; inline=${await note()}`, elapsed >= 1200 && Boolean(refetch) && (await selected()).includes(world.replacement.name));
    await user.screenshot();
  });

  await step("the inline Change action opens the model picker without silently choosing a pinned model", async () => {
    await user.click({ role: "button", label: /^Change$/ });
    await user.see({ testId: "composer-model-picker" });
    const current = (await probe.dom('[data-testid="composer-model-picker"] [data-model-key][data-checked="true"]')).elements;
    expect(current.some(row => row.text.includes(world.replacement.name))).toBe(true);
    expect(await selected()).toContain(world.replacement.name);
    evidence.recordAssertionEvidence("Change opens the ordinary picker with Sonnet still selected", `checked rows=${current.map(row => row.text).join(" | ")}; selected=${await selected()}`, current.some(row => row.text.includes(world.replacement.name)));
    await user.screenshot();
    await user.press("Escape");
  });

  await step("dismissing the explanation affects only this conversation", async () => {
    await user.click({ role: "button", label: "Dismiss model change" });
    await probe.eventually(note, { within: 5_000, label: "the dismissed explanation disappears", until: value => value === "" });
    await user.notSee({ testId: "model-recovery-note" });
    await openConversation("Independent planning", world.second.sessionId);
    await user.see({ testId: "model-recovery-note" }, { timeoutMs: 45_000 });
    expect(await selected()).toContain(world.replacement.name);
    expect(await note()).toContain("was removed by your organization");
    const otherNote = await note();
    await openConversation("Report planning", world.first.sessionId);
    await probe.eventually(note, { within: 5_000, label: "this conversation retains its dismissal", until: value => value === "" });
    await user.notSee({ testId: "model-recovery-note" });
    expect(await selected()).toContain(world.replacement.name);
    const dismissedNote = await note();
    evidence.recordAssertionEvidence("Dismissal stays local while the other chat gets its own explanation", `Report planning: Sonnet, note dismissed; Independent planning: Sonnet, removal note visible`, otherNote.includes("was removed by your organization") && dismissedNote === "");
    await user.screenshot();
  });

  await step("the member can switch back when their organization makes Opus available again", async () => {
    world.scenario("returned");
    await openConversation("Independent planning", world.second.sessionId);
    await user.see({ role: "button", label: /^Switch back$/ }, { timeoutMs: 45_000 });
    expect(await note()).toContain("is available again");
    expect(await selected()).toContain(world.replacement.name);
    await user.screenshot();
    await user.click({ role: "button", label: /^Switch back$/ });
    await probe.eventually(selected, { within: 15_000, label: "Opus restored by the member", until: value => value.includes(world.old.name) });
    await user.notSee({ testId: "model-recovery-note" });
    const reads = world.reads().filter(read => read.scenario === "returned" && read.kind === "legacy" && read.oldPresent);
    expect(reads.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("Restored assignment offers a voluntary return without changing the other conversation", `restored inventory reads=${reads.length}; member clicked Switch back; selected=${await selected()}; removal explanation cleared`, (await selected()).includes(world.old.name));
    await user.screenshot();
  });
});
