import { expect } from "vitest";
import { z } from "zod";
import { spec } from "@openwork/testkit";
import { computerShortcutsWorld } from "../worlds/computer-shortcuts.ts";

const test = spec.world(computerShortcutsWorld, { timeout: 420_000, resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "The program operates Electron's built-in page view through the desktop computer broker." } });
const resultSchema = z.object({ ok: z.boolean(), value: z.unknown().optional(), metrics: z.object({ actions: z.number(), transportCalls: z.number() }).optional() }).passthrough();

test("an agent fills a report, finds a project and saves once in one UI program", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  const witness = () => probe.browserFixtureState(world.origin);
  let tabId = "";

  await step("before: the report has no entered title or saved copy", async () => {
    await user.see("composer", { editable: true });
    const state = await witness();
    expect(state.records).toHaveLength(0);
    expect(state.inputValue).toBe("");
    evidence.recordAssertionEvidence("The report starts empty", `Saved copies: ${state.records.length}; title: ${state.inputValue}`, state.records.length === 0 && state.inputValue === "");
    await user.screenshot();
  });

  await step("after: one program fills the report, reveals a distant project and saves the requested options", async () => {
    const code = `
      await tools.ui.open({url:${JSON.stringify(`${world.origin}/shortcuts`)}});
      await tools.ui.waitFor({target:{role:"heading",name:"Computer toolkit project"}});
      const initial=await tools.ui.observe({});
      const distant=initial.elements.find(element=>element.name==="Project 60");
      const initiallyOffscreen=distant.bounds.y>initial.height;
      if(await tools.ui.exists({target:{role:"button",name:"Show filters"}})) await tools.ui.click({target:{role:"button",name:"Show filters"}});
      await tools.ui.fillForm({fields:[{target:{role:"textbox",name:"Draft title"},text:"Weekly release notes"}]});
      await tools.ui.setChecked({target:{role:"checkbox",name:"Include details"},checked:true});
      await tools.ui.setChecked({target:{role:"checkbox",name:"Include details"},checked:true});
      await tools.ui.select({target:{role:"combobox",name:"Report period"},option:"Weekly"});
      const listView=await tools.ui.observe({});
      const clipped=listView.elements.find(element=>element.role==="button" && element.name.startsWith("Project ") && element.visible && element.needsReveal);
      if(!clipped) return {missingClippedRow:true};
      await tools.ui.click({target:{role:"button",name:clipped.name}});
      const project=await tools.ui.scrollUntil({target:{role:"button",name:"Project 60"},container:{role:"region",name:"Projects"},maxPages:8});
      if(!project.found) return project;
      await tools.ui.click({target:project.target});
      await tools.ui.waitFor({target:{text:"Selected Project 60"}});
      await tools.ui.click({target:{role:"button",name:"Save draft"}});
      await tools.ui.waitFor({target:{text:"Saved 1"}});
      return {saved:true,project:60,initiallyOffscreen};
    `;
    const result = resultSchema.parse(await agent.computerProgram({ sessionId: world.session.sessionId, surface: "browser", code }));
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ saved: true, project: 60, initiallyOffscreen: true });
    const saved = await probe.eventually(witness, { within: 10_000, until: value => value.records.length === 1, label: "the requested report reaches the site exactly once" });
    expect(saved.inputValue).toBe("Weekly release notes");
    expect(saved.records).toEqual([{ method: "shortcuts:Weekly:true:Project 60", count: 1, signedIn: false }]);
    const tabs = (await probe.browserState()).tabs.filter(tab => tab.ownerSessionId === world.session.sessionId);
    expect(tabs).toHaveLength(1);
    tabId = tabs[0].id;
    await user.see({ role: "button", label: "Take over" });
    evidence.recordAssertionEvidence("The requested report is saved exactly once", `One program; ${result.metrics?.actions} actions; title ${saved.inputValue}; options ${saved.records[0].method}`, saved.records.length === 1 && saved.records[0].method === "shortcuts:Weekly:true:Project 60");
    await user.screenshot();
  });

  await step("another conversation cannot operate the report tab", async () => {
    await agent.run("session.open", { sessionId: world.neighbor.sessionId });
    await user.see("composer", { editable: true });
    const denied = resultSchema.parse(await agent.computerProgram({ sessionId: world.neighbor.sessionId, surface: "browser", tabId, code: "return await tools.ui.observe({});" }));
    expect(denied.ok).toBe(false);
    expect((await witness()).records).toHaveLength(1);
    evidence.recordAssertionEvidence("The other conversation cannot use the tab", "The foreign-tab program is refused and the report still has one saved copy.", denied.ok === false && (await witness()).records.length === 1);
    await user.screenshot();
  });

  await step("turning the feature off stops further computer programs", async () => {
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await world.setCapabilities({ computerUse: false });
    await probe.eventually(world.snapshot, { within: 60_000, until: value => typeof value === "object" && value !== null && "enabled" in value && value.enabled === false, label: "the desktop receives the admin rollout change" });
    const denied = resultSchema.parse(await agent.computerProgram({ sessionId: world.session.sessionId, surface: "browser", tabId, code: "await tools.ui.click({target:{role:'button',name:'Save draft'}}); return true;" }));
    expect(denied.ok).toBe(false);
    expect((await witness()).records).toHaveLength(1);
    await user.see("composer", { editable: true });
    evidence.recordAssertionEvidence("Rollout rollback prevents another save", "A program after rollback is refused; the saved report count remains one.", denied.ok === false && (await witness()).records.length === 1);
    await user.screenshot();
  });
});
