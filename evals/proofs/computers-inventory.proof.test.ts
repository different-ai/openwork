import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerNames as names, computersInventoryWorld } from "../worlds/computers-inventory.ts";

const test = spec.world(computersInventoryWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const myLegacyRows = '[role="row"]:has([data-testid^="my-computer-row-"])';
const teamLegacyRows = '[role="row"]:has([data-testid^="computer-row-"])';
const rows = '[data-testid^="computer-inventory-row-"]';
const historic = '[data-testid="computer-inventory-merged"]';
const tab = (name: string) => ({ testId: `computer-inventory-tab-${name}` });
const row = (id: string) => ({ testId: `computer-inventory-row-${id}` });
const selector = (testId: string) => `[data-testid="${testId}"]`;
const vagueStatus = /Not checked yet|Not reported/i;
const permissionsNote = "Computer Use needs permissions on this Mac.";
const wait = { timeoutMs: 90_000 };

test("Maya Okafor and Priya Nair find computers instead of sorting through sign-ins", async ({ world, user, probe, step, evidence }) => {
  const maya = user.on(world.maya), priya = user.on(world.priya);
  const myPage = probe.on(world.maya), teamPage = probe.on(world.priya);
  const { devices, mayaOldIds, instanceId } = world;
  const texts = async (page: typeof myPage, css: string) => (await page.dom(css)).elements.map((item) => item.text.replace(/\s+/g, " ").trim());
  const containing = (items: string[], label: string) => items.filter((item) => item.includes(label)).length;
  const tabLabels = async (css: string) => (await texts(teamPage, css)).map((label) => label.replace(/\s*(\d+)$/, " $1"));
  function witness(claim: string, value: string, ok: boolean) {
    evidence.recordAssertionEvidence(claim, value, ok);
    expect(ok, value).toBe(true);
  }
  async function openTab(name: string, firstId: string) {
    await priya.click(tab(name));
    await priya.see(row(firstId), wait);
    await probe.eventually(() => texts(teamPage, '[data-testid="computer-inventory"][aria-busy="false"]'), {
      within: 30_000, until: (items) => items.length === 1, label: "the selected tab settles",
    });
    const list = await texts(teamPage, rows);
    const vagueCells = containing(list.filter((text) => vagueStatus.test(text)), "");
    return { list, vagueCells };
  }

  await step("before: Maya sees five copies of her MacBook", async () => {
    await maya.see({ text: names.shared }, wait);
    const list = await texts(myPage, myLegacyRows);
    const macs = containing(list, names.mayaMac), workbots = containing(list, names.workbot), shared = containing(list, names.shared);
    await maya.screenshot();
    witness("Five MacBook sign-ins and two Workbot conversations take up separate rows", `${list.length - shared} rows for Maya's 3 computers: ${macs} MacBook, ${containing(list, names.mayaWindows)} Windows, ${workbots} Workbot; plus ${shared} shared computer`,
      list.length === 9 && macs === 5 && workbots === 2 && shared === 1 && containing(list, names.mayaWindows) === 1 && (await texts(myPage, selector("my-computer-inventory"))).length === 0);
  });

  await step("before: Priya sees sign-ins and Workbot conversations as separate computers", async () => {
    await priya.see({ testId: `computer-row-${devices.mayaMac.id}` }, wait);
    const list = await texts(teamPage, teamLegacyRows);
    const macs = containing(list, names.mayaMac), workbots = containing(list, names.workbot);
    const unchecked = list.some((text) => text.includes(names.buildBox) && text.includes("Not checked yet"));
    const instances = await texts(teamPage, selector(`registered-instance-${instanceId}`));
    await priya.screenshot();
    witness("The team list counts sign-ins, and OpenWork instances are in another table", `${list.length} rows by default; ${macs} MacBook sign-ins; ${workbots} Workbot conversations; Build box: ${unchecked ? "Not checked yet" : "unexpected status"}; ${instances.length} separate instance`,
      list.length === 17 && macs === 5 && workbots === 3 && unchecked && instances.length === 1 && instances.some((text) => text.includes(names.instance)));
  });

  await step("before: Priya opens the old list's hidden computers and finds the separate instances table", async () => {
    await priya.wheelAt({ x: 1170, y: 895, deltaY: 1100 });
    await priya.click({ testId: "computers-show-stale" });
    await priya.wheelAt({ x: 1170, y: 895, deltaY: 1100 });
    await priya.see({ text: names.olderMac }, wait);
    await priya.see({ text: names.instance }, wait);
    const list = await texts(teamPage, teamLegacyRows);
    await priya.screenshot();
    witness("The legacy list has one more row after showing the oldest desktop", `${list.length} computer rows including ${containing(list, names.olderMac)} oldest desktop; 1 separate OpenWork instance`,
      list.length === 18 && containing(list, names.olderMac) === 1 && containing(list, names.olderLinux) === 1);
  });

  await step("after: the platform operator turns Computers on just for Northwind Labs", async () => {
    await world.turnOnComputers();
    await maya.reload();
    await maya.see({ testId: "my-computer-inventory" }, wait);
    const legacy = await texts(myPage, myLegacyRows);
    const current = await texts(myPage, selector("my-computer-inventory"));
    witness("Northwind's member page switches to the new inventory", `${current.length} new inventory; ${legacy.length} legacy rows`, current.length === 1 && legacy.length === 0);
  });

  await step("after: Maya sees one row per computer and four older sign-ins folded away", async () => {
    await maya.see(row(devices.mayaMac.id), wait);
    await maya.see({ testId: "computer-inventory-merged" });
    const list = await texts(myPage, rows);
    const shared = containing(list, names.shared);
    const merged = await texts(myPage, historic);
    const hidden = (await texts(myPage, `${historic} li`)).length;
    await maya.screenshot();
    witness("Maya's MacBook, Windows PC and Workbot computer each have one row", `${list.length - shared} personal rows plus ${shared} organization-shared row; ${merged.join(" ")}; ${hidden} older sign-ins shown by default`,
      list.length === 4 && shared === 1 && [names.mayaMac, names.mayaWindows, names.workbot].every((label) => containing(list, label) === 1)
      && merged.some((text) => text.includes("4 older sign-ins") && text.includes("merged in")) && hidden === 0 && list.every((text) => !vagueStatus.test(text)));
  });

  await step("after: Maya can show the four MacBook sign-ins without adding rows to her inventory", async () => {
    await maya.click({ role: "button", label: "Show" });
    await maya.see({ role: "button", label: "Hide" });
    const merged = await texts(myPage, `${historic} li`);
    const list = await texts(myPage, rows);
    await maya.screenshot();
    witness("The history shows the four MacBook sign-ins and when each was last seen", `${merged.length} history rows: ${merged.join(" | ")}; ${list.length} computer rows still in the list`,
      merged.length === mayaOldIds.length && merged.every((text) => text.includes(names.mayaMac) && text.includes("Last seen")) && list.length === 4);
  });

  async function detail(person: typeof maya, page: typeof myPage, id: string, name: string, expectedAppVersion: string) {
    await person.click(row(id));
    await person.see({ role: "heading", label: "Installed" }, wait);
    const subject = selector(`computer-inventory-detail-${id}`);
    const content = await probe.eventually(async () => (await texts(page, subject)).join(" "), {
      within: 30_000, until: (text) => text.includes("App version"), label: "the installation facts replace the loading skeleton",
    });
    const cards = await texts(page, `${subject} h3`);
    const cellCounts = await Promise.all(["status", "run-code", "send-tasks", "read-sessions"].map(async (attribute) => (await texts(page, `${selector(row(id).testId)} [data-${attribute}]`)).length));
    await person.screenshot();
    witness(`${name} has installation, code and session details`, `${cards.length} cards (${cards.join(", ")}); app ${expectedAppVersion}; ${cellCounts.reduce((sum, count) => sum + count, 0)} status and access cells in the row`,
      cards.join(" | ") === "Installed | Run code here | Sessions" && content.includes(expectedAppVersion) && !vagueStatus.test(content) && cellCounts.every((count) => count === 1));
  }

  await step("after: Maya opens the MacBook's installation and access details", async () => {
    await maya.click({ role: "button", label: "Hide" });
    await detail(maya, myPage, devices.mayaMac.id, "Maya's MacBook", "1.6.0");
  });

  await step("after: Priya sees the desktop inventory and each tab's count", async () => {
    await priya.navigate(world.url("/dashboard/computers"));
    await priya.see(row(devices.tomasMac.id), wait);
    const list = await texts(teamPage, rows);
    const tabs = await tabLabels('[data-testid="computer-inventory"] [role="tab"]');
    const rules = await texts(teamPage, selector("computer-inventory-rules"));
    const older = await texts(teamPage, selector("computer-inventory-older"));
    const tomas = (await texts(teamPage, selector(row(devices.tomasMac.id).testId))).join(" ");
    const status = (await texts(teamPage, `${selector(row(devices.tomasMac.id).testId)} [data-status="online"]`)).join(" ");
    const offline = (await texts(teamPage, `${selector(row(devices.tomasLinux.id).testId)} [data-status="offline"]`)).join(" ");
    const headers = await texts(teamPage, '[data-testid="computer-inventory"] [role="columnheader"]');
    await priya.screenshot();
    witness("The Mac with missing permissions is still online, and the Linux PC shows its last contact", `${list.length} desktop rows by default; ${tabs.join(" / ")}; ${status} with permission note: ${tomas.includes(permissionsNote)}; Linux PC: ${offline}; ${older.join(" ")}`,
      list.length === 5 && containing(list, names.mayaMac) === 1 && status === "Online" && tomas.includes(permissionsNote)
      && /Offline.*Last seen 3 days ago/.test(offline) && tabs.join(" / ") === "Desktops 7 / Cloud 5 / Needs attention 1 / Former members 2"
      && ["Computer", "Owner", "Status", "Run code here", "Send it tasks", "Read its sessions"].every((label) => headers.includes(label))
      && older.some((text) => text.includes("2 not heard")) && rules.length === 1 && rules.some((text) => text.includes("Change rules")) && list.every((text) => !vagueStatus.test(text)));
  });

  await step("after: Priya can filter the desktop list by an owner's name", async () => {
    const filter = { placeholder: "Filter by name or owner" };
    await priya.type(filter, "Tomás Rivera");
    const getList = () => texts(teamPage, rows);
    const list = await probe.eventually(getList, { within: 30_000, until: (items) => items.length === 2, label: "the owner filter leaves two desktops" });
    await priya.screenshot();
    witness("Filtering for Tomás leaves his two recently heard-from desktops", `${list.length} rows; ${[names.tomasMac, names.tomasLinux].filter((label) => containing(list, label) === 1).join(", ")}`,
      list.length === 2 && [names.tomasMac, names.tomasLinux].every((label) => containing(list, label) === 1));
    await priya.navigate(world.url("/dashboard/computers"));
    await priya.see(row(devices.priyaMac.id), wait);
  });

  await step("after: Priya finds both Workbot computers and the OpenWork instance under Cloud", async () => {
    const { list, vagueCells } = await openTab("cloud", devices.buildBox.id);
    const workbots = list.filter((text) => text.includes(names.workbot));
    const build = (await texts(teamPage, `${selector(row(devices.buildBox.id).testId)} [data-status="starts_when_needed"]`)).join(" ");
    const instance = (await texts(teamPage, selector(row(instanceId).testId))).join(" ");
    const separate = await texts(teamPage, selector("registered-instances"));
    await priya.screenshot();
    witness("Cloud has one Workbot computer per person, the inactive Build box and the registered instance", `${list.length} cloud rows; ${workbots.length} Workbot computers; Build box: ${build}; ${Number(Boolean(instance))} in-list instance; ${separate.length} separate tables; ${vagueCells} vague statuses`,
      list.length === 5 && workbots.length === 2 && ["Maya Okafor", "Tomás Rivera"].every((label) => containing(workbots, label) === 1)
      && build === "Starts when needed" && instance.includes(names.instance) && instance.includes("Ready") && containing(list, names.shared) === 1 && separate.length === 0 && vagueCells === 0);
  });

  await step("after: Priya sees the Mac that needs permissions under Needs attention", async () => {
    const { list, vagueCells } = await openTab("attention", devices.tomasMac.id);
    const selected = await tabLabels('[role="tab"][aria-selected="true"]');
    await priya.screenshot();
    witness("Only the Mac with a permissions issue needs attention; its status remains Online", `${list.length} row under ${selected.join(" ")}; ${list.join(" ")}; ${vagueCells} vague statuses`,
      list.length === 1 && selected.join(" ") === "Needs attention 1" && list.some((text) => text.includes(names.tomasMac) && text.includes(permissionsNote) && text.includes("Online")) && vagueCells === 0);
  });

  await step("after: Priya opens Tomás's desktop details without taking ownership", async () => {
    await detail(priya, teamPage, devices.tomasMac.id, "Tomás's desktop", "1.6.0");
  });

  await step("after: Priya finds both of Jonas's computers and can remove them", async () => {
    const { list, vagueCells } = await openTab("former", devices.jonasMac.id);
    const actions = await texts(teamPage, '[data-testid^="computer-inventory-menu-"]');
    await priya.click({ testId: `computer-inventory-menu-${devices.jonasMac.id}` });
    await priya.see({ testId: `computer-inventory-remove-${devices.jonasMac.id}` });
    await priya.screenshot();
    const selected = await tabLabels('[role="tab"][aria-selected="true"]');
    witness("Both of Jonas's computers move to Former members with a removal action", `${list.length} computers under ${selected.join(" ")}; ${actions.length} action menus; ${vagueCells} vague statuses`,
      list.length === 2 && selected.join(" ") === "Former members 2" && [names.jonasMac, names.jonasWindows].every((label) => containing(list, label) === 1)
      && containing(list, "Former member") === 2 && actions.length === 2 && vagueCells === 0);
    await priya.press("Escape");
  });

  await step("after: Priya reveals the two desktops not heard from in a week", async () => {
    const before = await openTab("desktops", devices.mayaMac.id);
    await priya.click({ role: "button", label: "Show older" });
    await priya.see(row(devices.olderMac.id), wait);
    const list = await texts(teamPage, rows);
    const monitors = list.filter((text) => text.includes(names.olderLinux) || text.includes(names.olderMac));
    await priya.screenshot();
    witness("Show older adds two offline desktops and no duplicate sign-ins", `${before.list.length} default desktop rows; ${list.length} with older computers; last contacts: ${monitors.join(" | ")}`,
      before.list.length === 5 && list.length === 7 && containing(list, names.mayaMac) === 1 && monitors.length === 2
      && monitors.every((text) => text.includes("Offline") && text.includes("Last seen")) && list.every((text) => !vagueStatus.test(text)));
  });

  await step("after: Priya follows Change rules to the Computers section of Organization settings", async () => {
    await priya.click({ role: "link", label: "Change rules" });
    await priya.see({ testId: "computer-rules" }, wait);
    await priya.see({ testId: "computer-rules-run-code" }, wait);
    const hash = new URL(await teamPage.url()).hash;
    const sections = await texts(teamPage, '#computers[data-testid="computer-rules"]');
    await priya.screenshot();
    witness("Change rules lands on the Computers section with the code rule visible", `${sections.length} Computers section; ${hash} anchor`, sections.length === 1 && hash === "#computers");
  });

  await step("after: Maya cannot see Tomás's or Jonas's computers or open the team inventory", async () => {
    await maya.see(row(devices.mayaMac.id));
    const personal = await texts(myPage, rows);
    const privateNames = [names.tomasMac, names.tomasLinux, names.buildBox, names.jonasMac, names.jonasWindows, names.olderLinux];
    const leaks = privateNames.filter((label) => containing(personal, label) > 0);
    const [admin, tomas, jonas] = await Promise.all([
      world.memberRequest("/v1/org/computers/inventory"),
      world.memberRequest(`/v1/computers/inventory/${devices.tomasMac.id}`),
      world.memberRequest(`/v1/computers/inventory/${devices.jonasMac.id}`),
    ]);
    await maya.navigate(world.url("/dashboard/computers"));
    await probe.eventually(async () => new URL(await myPage.url()).pathname, {
      within: 30_000, until: (path) => path === "/dashboard", label: "Maya returns to the dashboard instead of entering team Computers",
    });
    const team = await texts(myPage, selector("computer-inventory"));
    witness("Other members' private computers are absent and Maya is denied the team inventory", `${personal.length} permitted rows; ${leaks.length} private rows visible; team inventory HTTP ${admin.response.status}; private details HTTP ${tomas.response.status}/${jonas.response.status}; ${team.length} team lists on the redirected page`,
      personal.length === 4 && leaks.length === 0 && admin.response.status === 403 && tomas.response.status === 404 && jonas.response.status === 404 && team.length === 0);
  });
});
