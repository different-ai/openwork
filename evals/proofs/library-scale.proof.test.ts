import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emptyLibraryScale, singleLibraryScale, smallLibraryScale, largeLibraryScale } from "../worlds/library-scale.ts";

const empty = spec.world(emptyLibraryScale, { timeout: 240_000, resources: { surfaces: ["appWeb"], services: [] } });
const single = spec.world(singleLibraryScale, { timeout: 240_000, resources: { surfaces: ["appWeb"], services: [] } });
const small = spec.world(smallLibraryScale, { timeout: 240_000, resources: { surfaces: ["appWeb"], services: [] } });
const large = spec.world(largeLibraryScale, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] } });

// Timings cover trusted user input through a visible, captured app frame, not source processing.
empty("a member browses and searches 0 skills in a bounded Library and menu", async ({ world, user, probe, step, evidence }) => {
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await step("after: the real Library renders only one page of workspace skills", async () => {
      const started = performance.now();
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/extensions`, world.app.webUrl).href);
      await user.type({ label: "Filter by name" }, "scale-skill");
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      else await user.see({ text: "scale-skill-00000" });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(Math.min(world.count, 20));
      if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("Actual inventory to captured Library frame", `${world.count} workspace skills; ${rows.elements.length} mounted rows; ${elapsed} ms navigation/filter-to-captured-frame`, rows.elements.length <= 20 && elapsed < 30000);
      expect(elapsed).toBeLessThan(30000);
    });
    await step("search reaches a later skill without mounting the rest of the inventory", async () => {
      const started = performance.now();
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next On this computer items" });
        await user.see({ text: "Showing 21–40 of 10000" });
      }
      const name = world.count === 0 ? "not-present" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ label: "Filter by name" }, name, { replace: true });
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else await user.see({ text: name });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(world.count === 0 ? 0 : 1);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("A full-inventory search is not a first-page search", `${world.count} skills; final item ${name}; ${rows.elements.length} rows; ${elapsed} ms input-to-captured-frame`, rows.elements.length <= 1 && elapsed < 5000);
      expect(elapsed).toBeLessThan(5000);
    });
    await step("the composer skill menu is bounded and finds the same final skill", async () => {
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/session/${world.session.sessionId}`, world.app.webUrl).href);
      await user.see("composer");
      const started = performance.now();
      await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
      await user.click({ role: "option", label: /^Skills/ });
      if (world.count > 20) await user.see({ text: /1–20 of/ });
      const initial = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(initial).toBeLessThanOrEqual(20);
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next results" });
        await user.see({ text: /21–40 of/ });
        expect((await probe.dom('[data-plus-menu-item="skill"]')).elements.length).toBeLessThanOrEqual(20);
      }
      const name = world.count === 0 ? "not-present-unique" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ placeholder: "Search skills" }, name);
      if (world.count === 0) await user.see({ text: /No matches/ });
      else await user.see({ role: "option", label: new RegExp(`Scale skill ${String(world.count - 1).padStart(5, "0")}`, "i") });
      const visible = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(visible).toBeLessThanOrEqual(20);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("The real skill menu remains searchable and bounded", `${world.count} skills; ${initial} browse rows; ${visible} search rows; ${elapsed} ms open/search-to-captured-frame`, initial <= 20 && visible <= 20 && elapsed < 10000);
      expect(elapsed).toBeLessThan(10000);
      await user.press("Escape");
      await user.press("Escape");
      const returned = await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing the menu returns focus after its exit transition", until: value => value.elements.some(element => element.focused) });
      expect(returned.elements.some(element => element.focused)).toBe(true);
    });
    if (world.count > 20) await step("search, navigation and closing permanently reset menu paging", async () => {
      const openSkills = async () => {
        await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
        await user.click({ role: "option", label: /^Skills/ });
      };
      await openSkills();
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.type({ placeholder: "Search skills" }, "scale-skill-09999");
      await user.see({ role: "option", label: /Scale skill 09999/i });
      await user.type({ placeholder: "Search skills" }, "", { replace: true });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.see({ role: "option", label: /^Skills/ });
      await user.click({ role: "option", label: /^Skills/ });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.press("Escape");
      await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing finishes before reopening the menu", until: value => value.elements.some(element => element.focused) });
      await openSkills();
      await user.see({ text: /1–20 of/ });
      const paging = (await probe.dom("[data-plus-menu-pages]")).elements[0]?.text ?? "";
      expect(paging).toMatch(/^1–20 of/);
      evidence.recordAssertionEvidence("No earlier page can silently revive", `After search/clear, back/reenter and close/reopen: ${paging}`, /^1–20 of/.test(paging));
      await user.screenshot();
    });
  });

single("a member browses and searches 1 skills in a bounded Library and menu", async ({ world, user, probe, step, evidence }) => {
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await step("after: the real Library renders only one page of workspace skills", async () => {
      const started = performance.now();
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/extensions`, world.app.webUrl).href);
      await user.type({ label: "Filter by name" }, "scale-skill");
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      else await user.see({ text: "scale-skill-00000" });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(Math.min(world.count, 20));
      if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("Actual inventory to captured Library frame", `${world.count} workspace skills; ${rows.elements.length} mounted rows; ${elapsed} ms navigation/filter-to-captured-frame`, rows.elements.length <= 20 && elapsed < 30000);
      expect(elapsed).toBeLessThan(30000);
    });
    await step("search reaches a later skill without mounting the rest of the inventory", async () => {
      const started = performance.now();
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next On this computer items" });
        await user.see({ text: "Showing 21–40 of 10000" });
      }
      const name = world.count === 0 ? "not-present" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ label: "Filter by name" }, name, { replace: true });
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else await user.see({ text: name });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(world.count === 0 ? 0 : 1);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("A full-inventory search is not a first-page search", `${world.count} skills; final item ${name}; ${rows.elements.length} rows; ${elapsed} ms input-to-captured-frame`, rows.elements.length <= 1 && elapsed < 5000);
      expect(elapsed).toBeLessThan(5000);
    });
    await step("the composer skill menu is bounded and finds the same final skill", async () => {
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/session/${world.session.sessionId}`, world.app.webUrl).href);
      await user.see("composer");
      const started = performance.now();
      await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
      await user.click({ role: "option", label: /^Skills/ });
      if (world.count > 20) await user.see({ text: /1–20 of/ });
      const initial = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(initial).toBeLessThanOrEqual(20);
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next results" });
        await user.see({ text: /21–40 of/ });
        expect((await probe.dom('[data-plus-menu-item="skill"]')).elements.length).toBeLessThanOrEqual(20);
      }
      const name = world.count === 0 ? "not-present-unique" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ placeholder: "Search skills" }, name);
      if (world.count === 0) await user.see({ text: /No matches/ });
      else await user.see({ role: "option", label: new RegExp(`Scale skill ${String(world.count - 1).padStart(5, "0")}`, "i") });
      const visible = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(visible).toBeLessThanOrEqual(20);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("The real skill menu remains searchable and bounded", `${world.count} skills; ${initial} browse rows; ${visible} search rows; ${elapsed} ms open/search-to-captured-frame`, initial <= 20 && visible <= 20 && elapsed < 10000);
      expect(elapsed).toBeLessThan(10000);
      await user.press("Escape");
      await user.press("Escape");
      const returned = await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing the menu returns focus after its exit transition", until: value => value.elements.some(element => element.focused) });
      expect(returned.elements.some(element => element.focused)).toBe(true);
    });
    if (world.count > 20) await step("search, navigation and closing permanently reset menu paging", async () => {
      const openSkills = async () => {
        await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
        await user.click({ role: "option", label: /^Skills/ });
      };
      await openSkills();
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.type({ placeholder: "Search skills" }, "scale-skill-09999");
      await user.see({ role: "option", label: /Scale skill 09999/i });
      await user.type({ placeholder: "Search skills" }, "", { replace: true });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.see({ role: "option", label: /^Skills/ });
      await user.click({ role: "option", label: /^Skills/ });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.press("Escape");
      await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing finishes before reopening the menu", until: value => value.elements.some(element => element.focused) });
      await openSkills();
      await user.see({ text: /1–20 of/ });
      const paging = (await probe.dom("[data-plus-menu-pages]")).elements[0]?.text ?? "";
      expect(paging).toMatch(/^1–20 of/);
      evidence.recordAssertionEvidence("No earlier page can silently revive", `After search/clear, back/reenter and close/reopen: ${paging}`, /^1–20 of/.test(paging));
      await user.screenshot();
    });
  });

small("a member browses and searches 20 skills in a bounded Library and menu", async ({ world, user, probe, step, evidence }) => {
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await step("after: the real Library renders only one page of workspace skills", async () => {
      const started = performance.now();
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/extensions`, world.app.webUrl).href);
      await user.type({ label: "Filter by name" }, "scale-skill");
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      else await user.see({ text: "scale-skill-00000" });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(Math.min(world.count, 20));
      if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("Actual inventory to captured Library frame", `${world.count} workspace skills; ${rows.elements.length} mounted rows; ${elapsed} ms navigation/filter-to-captured-frame`, rows.elements.length <= 20 && elapsed < 30000);
      expect(elapsed).toBeLessThan(30000);
    });
    await step("search reaches a later skill without mounting the rest of the inventory", async () => {
      const started = performance.now();
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next On this computer items" });
        await user.see({ text: "Showing 21–40 of 10000" });
      }
      const name = world.count === 0 ? "not-present" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ label: "Filter by name" }, name, { replace: true });
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else await user.see({ text: name });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(world.count === 0 ? 0 : 1);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("A full-inventory search is not a first-page search", `${world.count} skills; final item ${name}; ${rows.elements.length} rows; ${elapsed} ms input-to-captured-frame`, rows.elements.length <= 1 && elapsed < 5000);
      expect(elapsed).toBeLessThan(5000);
    });
    await step("the composer skill menu is bounded and finds the same final skill", async () => {
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/session/${world.session.sessionId}`, world.app.webUrl).href);
      await user.see("composer");
      const started = performance.now();
      await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
      await user.click({ role: "option", label: /^Skills/ });
      if (world.count > 20) await user.see({ text: /1–20 of/ });
      const initial = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(initial).toBeLessThanOrEqual(20);
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next results" });
        await user.see({ text: /21–40 of/ });
        expect((await probe.dom('[data-plus-menu-item="skill"]')).elements.length).toBeLessThanOrEqual(20);
      }
      const name = world.count === 0 ? "not-present-unique" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ placeholder: "Search skills" }, name);
      if (world.count === 0) await user.see({ text: /No matches/ });
      else await user.see({ role: "option", label: new RegExp(`Scale skill ${String(world.count - 1).padStart(5, "0")}`, "i") });
      const visible = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(visible).toBeLessThanOrEqual(20);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("The real skill menu remains searchable and bounded", `${world.count} skills; ${initial} browse rows; ${visible} search rows; ${elapsed} ms open/search-to-captured-frame`, initial <= 20 && visible <= 20 && elapsed < 10000);
      expect(elapsed).toBeLessThan(10000);
      await user.press("Escape");
      await user.press("Escape");
      const returned = await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing the menu returns focus after its exit transition", until: value => value.elements.some(element => element.focused) });
      expect(returned.elements.some(element => element.focused)).toBe(true);
    });
    if (world.count > 20) await step("search, navigation and closing permanently reset menu paging", async () => {
      const openSkills = async () => {
        await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
        await user.click({ role: "option", label: /^Skills/ });
      };
      await openSkills();
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.type({ placeholder: "Search skills" }, "scale-skill-09999");
      await user.see({ role: "option", label: /Scale skill 09999/i });
      await user.type({ placeholder: "Search skills" }, "", { replace: true });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.see({ role: "option", label: /^Skills/ });
      await user.click({ role: "option", label: /^Skills/ });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.press("Escape");
      await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing finishes before reopening the menu", until: value => value.elements.some(element => element.focused) });
      await openSkills();
      await user.see({ text: /1–20 of/ });
      const paging = (await probe.dom("[data-plus-menu-pages]")).elements[0]?.text ?? "";
      expect(paging).toMatch(/^1–20 of/);
      evidence.recordAssertionEvidence("No earlier page can silently revive", `After search/clear, back/reenter and close/reopen: ${paging}`, /^1–20 of/.test(paging));
      await user.screenshot();
    });
  });

large("a member browses and searches 10000 skills in a bounded Library and menu", async ({ world, user, probe, step, evidence }) => {
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await step("after: the real Library renders only one page of workspace skills", async () => {
      const started = performance.now();
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/extensions`, world.app.webUrl).href);
      await user.type({ label: "Filter by name" }, "scale-skill");
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      else await user.see({ text: "scale-skill-00000" });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(Math.min(world.count, 20));
      if (world.count > 20) await user.see({ text: "Showing 1–20 of 10000" });
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("Actual inventory to captured Library frame", `${world.count} workspace skills; ${rows.elements.length} mounted rows; ${elapsed} ms navigation/filter-to-captured-frame`, rows.elements.length <= 20 && elapsed < 30000);
      expect(elapsed).toBeLessThan(30000);
    });
    await step("search reaches a later skill without mounting the rest of the inventory", async () => {
      const started = performance.now();
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next On this computer items" });
        await user.see({ text: "Showing 21–40 of 10000" });
      }
      const name = world.count === 0 ? "not-present" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ label: "Filter by name" }, name, { replace: true });
      if (world.count === 0) await user.see({ text: "No library items match these filters." });
      else await user.see({ text: name });
      const rows = await probe.dom('[data-library-row-key^="skill:"]');
      expect(rows.elements.length).toBe(world.count === 0 ? 0 : 1);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("A full-inventory search is not a first-page search", `${world.count} skills; final item ${name}; ${rows.elements.length} rows; ${elapsed} ms input-to-captured-frame`, rows.elements.length <= 1 && elapsed < 5000);
      expect(elapsed).toBeLessThan(5000);
    });
    await step("the composer skill menu is bounded and finds the same final skill", async () => {
      await user.navigate(new URL(`/workspace/${world.workspace.workspaceId}/session/${world.session.sessionId}`, world.app.webUrl).href);
      await user.see("composer");
      const started = performance.now();
      await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
      await user.click({ role: "option", label: /^Skills/ });
      if (world.count > 20) await user.see({ text: /1–20 of/ });
      const initial = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(initial).toBeLessThanOrEqual(20);
      if (world.count > 20) {
        await user.click({ role: "button", label: "Next results" });
        await user.see({ text: /21–40 of/ });
        expect((await probe.dom('[data-plus-menu-item="skill"]')).elements.length).toBeLessThanOrEqual(20);
      }
      const name = world.count === 0 ? "not-present-unique" : `scale-skill-${String(world.count - 1).padStart(5, "0")}`;
      await user.type({ placeholder: "Search skills" }, name);
      if (world.count === 0) await user.see({ text: /No matches/ });
      else await user.see({ role: "option", label: new RegExp(`Scale skill ${String(world.count - 1).padStart(5, "0")}`, "i") });
      const visible = (await probe.dom('[data-plus-menu-item="skill"]')).elements.length;
      expect(visible).toBeLessThanOrEqual(20);
      await user.screenshot();
      const elapsed = Math.round(performance.now() - started);
      evidence.recordAssertionEvidence("The real skill menu remains searchable and bounded", `${world.count} skills; ${initial} browse rows; ${visible} search rows; ${elapsed} ms open/search-to-captured-frame`, initial <= 20 && visible <= 20 && elapsed < 10000);
      expect(elapsed).toBeLessThan(10000);
      await user.press("Escape");
      await user.press("Escape");
      const returned = await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing the menu returns focus after its exit transition", until: value => value.elements.some(element => element.focused) });
      expect(returned.elements.some(element => element.focused)).toBe(true);
    });
    if (world.count > 20) await step("search, navigation and closing permanently reset menu paging", async () => {
      const openSkills = async () => {
        await user.click({ role: "button", label: "Add files, skills, connectors, and more" });
        await user.click({ role: "option", label: /^Skills/ });
      };
      await openSkills();
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.type({ placeholder: "Search skills" }, "scale-skill-09999");
      await user.see({ role: "option", label: /Scale skill 09999/i });
      await user.type({ placeholder: "Search skills" }, "", { replace: true });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.see({ role: "option", label: /^Skills/ });
      await user.click({ role: "option", label: /^Skills/ });
      await user.see({ text: /1–20 of/ });
      await user.click({ role: "button", label: "Next results" });
      await user.see({ text: /21–40 of/ });
      await user.press("Escape");
      await user.press("Escape");
      await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), { within: 3000, label: "closing finishes before reopening the menu", until: value => value.elements.some(element => element.focused) });
      await openSkills();
      await user.see({ text: /1–20 of/ });
      const paging = (await probe.dom("[data-plus-menu-pages]")).elements[0]?.text ?? "";
      expect(paging).toMatch(/^1–20 of/);
      evidence.recordAssertionEvidence("No earlier page can silently revive", `After search/clear, back/reenter and close/reopen: ${paging}`, /^1–20 of/.test(paging));
      await user.screenshot();
    });
  });
