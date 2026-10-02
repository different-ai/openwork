import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { plusMenuWeb } from "../worlds/composer-plus-menu.ts";

const test = spec.world(plusMenuWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const plusButton = { role: "button", label: "Add files, skills, connectors, and more" } as const;
const menuSearch = { placeholder: "Search files, skills, connectors" } as const;
const highlightedRow = "[data-plus-menu-item][data-highlighted]";

test("a member: I want the composer filter to forgive typos so I find things fast", async ({ user, probe, step, evidence }) => {
  const highlighted = async () => {
    const row = (await probe.dom(highlightedRow)).elements[0]?.text ?? "";
    const matched = (await probe.dom(`${highlightedRow} [data-plus-menu-match]`)).elements.map((element) => element.text);
    const rows = (await probe.dom("[data-composer-plus-menu] [data-plus-menu-item]")).elements.map((element) => element.text);
    return { row, matched, rows };
  };

  await step("1. skipped letters: “hbspt” puts the HubSpot connector first with its matched letters marked", async () => {
    await user.click(plusButton);
    await user.type(menuSearch, "hbspt");
    await user.see({ text: "Connectors" });
    await user.see({ role: "option", label: /^HubSpot/ });
    const first = await probe.eventually(highlighted, {
      within: 10_000, label: "HubSpot is the highlighted first result", until: (value) => value.row.startsWith("HubSpot"),
    });
    evidence.recordAssertionEvidence("“hbspt” finds HubSpot first", `first row "${first.row}", marked letters ${JSON.stringify(first.matched)}`, first.row.startsWith("HubSpot"));
    expect(first.matched.join("")).toBe("HbSpt");
    await user.screenshot();
  });

  await step("2. abbreviated words: “cust brf” finds Customer briefing", async () => {
    await user.type(menuSearch, "cust brf", { replace: true });
    await user.see({ text: "Skills" });
    const first = await probe.eventually(highlighted, {
      within: 10_000, label: "Customer briefing is the highlighted result", until: (value) => value.row.startsWith("Customer briefing"),
    });
    evidence.recordAssertionEvidence("“cust brf” finds Customer briefing", `first row "${first.row}", marked letters ${JSON.stringify(first.matched)}`, true);
    expect(first.matched.join("")).toBe("Custbrf");
    await user.screenshot();
  });

  await step("3. a swapped letter: “hubsopt” still puts HubSpot first", async () => {
    await user.type(menuSearch, "hubsopt", { replace: true });
    const first = await probe.eventually(highlighted, {
      within: 10_000, label: "HubSpot survives a transposition", until: (value) => value.row.startsWith("HubSpot"),
    });
    evidence.recordAssertionEvidence("“hubsopt” still finds HubSpot first", `first row "${first.row}"`, first.row.startsWith("HubSpot"));
    await user.screenshot();
  });

  await step("after: nonsense shows one calm no-results line and ways to browse instead", async () => {
    await user.type(menuSearch, "zqx", { replace: true });
    await user.see({ text: "No matches for “zqx”" });
    await user.see({ role: "option", label: /^Skills/ });
    await user.see({ role: "option", label: /^Connectors/ });
    await user.notSee({ role: "option", label: /^HubSpot/ });
    await user.screenshot();
  });
});
