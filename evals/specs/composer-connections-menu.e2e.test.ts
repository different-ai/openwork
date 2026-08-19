import { expect } from "vitest";
import {
  createOrgConnection,
  evalIn,
  go,
  readUsableConnection,
  waitFor,
} from "@openwork/behaviors";
import { app, eventually, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `composer connections menu skipped — needs: ${missingRequirements.join(", ")}`
  : "the composer connections menu scrolls through Den inventory and signs in on the row";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Composer connections menu ${Date.now()}`,
      admin: { name: "Sarah" },
    },
    mocks: { connector: mcpMock() },
  });

  const connections: Array<{ id: string; name: string }> = [];
  for (let index = 1; index <= 14; index += 1) {
    connections.push(await createOrgConnection(den.admin, {
      name: `Composer connection ${String(index).padStart(2, "0")}`,
      url: den.mocks.connector.mcpUrl,
      authType: "oauth",
      credentialMode: "per_member",
      access: { orgWide: true },
    }));
  }

  await using desktop = await app({ den, as: "admin", place });
  await go(desktop, `/workspace/${desktop.workspaceId}/session`);
  await waitFor(desktop, `Boolean(document.querySelector('button[title="Agents, commands, skills, plugins, and connections"]'))`, {
    timeoutMs: 60_000,
    label: "composer capability menu trigger",
  });

  const opened = await evalIn(desktop, `(() => {
    const trigger = document.querySelector('button[title="Agents, commands, skills, plugins, and connections"]');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(opened).toBe(true);
  await waitFor(desktop, `[...document.querySelectorAll('button')]
    .some((entry) => (entry.textContent ?? "").trim() === "Connections (MCPs)")`, {
    timeoutMs: 20_000,
    label: "composer capability menu",
  });

  const connectionsSelected = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? "").trim() === "Connections (MCPs)");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(connectionsSelected).toBe(true);
  await waitFor(desktop, `[...document.querySelectorAll('div')]
    .filter((entry) => /^Composer connection \\d+$/.test((entry.textContent ?? "").trim()) && entry.children.length === 0)
    .length >= 14`, {
    timeoutMs: 60_000,
    label: "all Den connections in the composer menu",
  });

  const overflow = await evalIn(desktop, `(() => {
    const section = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? "").trim() === "Connections (MCPs)");
    const navigation = section?.parentElement;
    const panel = navigation?.parentElement?.parentElement;
    const titles = [...document.querySelectorAll('div')]
      .filter((entry) => /^Composer connection \\d+$/.test((entry.textContent ?? "").trim()) && entry.children.length === 0);
    const rows = titles.map((title) => ({ title, row: title.parentElement?.parentElement?.parentElement }))
      .filter((entry) => entry.row instanceof HTMLElement);
    const list = rows[0]?.row?.parentElement?.parentElement;
    if (!(panel instanceof HTMLElement)
      || !(navigation instanceof HTMLElement)
      || !(list instanceof HTMLElement)
      || rows.length < 14) return null;
    list.scrollTop = 0;
    const listRect = list.getBoundingClientRect();
    const target = rows.findLast((entry) => entry.row instanceof HTMLElement
      && entry.row.getBoundingClientRect().bottom > listRect.bottom);
    if (!target || !(target.row instanceof HTMLElement)) return null;
    return {
      panelHeight: panel.clientHeight,
      navigationOverflow: getComputedStyle(navigation).overflowY,
      listOverflow: getComputedStyle(list).overflowY,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      targetInitiallyBelow: target.row.getBoundingClientRect().bottom > listRect.bottom,
      targetName: (target.title.textContent ?? "").trim(),
    };
  })()`);
  expect(overflow).toMatchObject({
    navigationOverflow: "auto",
    listOverflow: "auto",
    targetInitiallyBelow: true,
  });
  expect(isRecord(overflow) && typeof overflow.panelHeight === "number" && overflow.panelHeight).toBeGreaterThan(180);
  expect(isRecord(overflow) && typeof overflow.listScrollHeight === "number" && typeof overflow.listClientHeight === "number"
    ? overflow.listScrollHeight
    : 0).toBeGreaterThan(isRecord(overflow) && typeof overflow.listClientHeight === "number" ? overflow.listClientHeight : 0);
  const targetName = isRecord(overflow) && typeof overflow.targetName === "string" ? overflow.targetName : "";
  const targetConnection = connections.find((connection) => connection.name === targetName);
  expect(targetConnection).toBeDefined();
  if (!targetConnection) throw new Error(`Could not map the overflow row ${JSON.stringify(targetName)} to a Den connection.`);
  const targetId = targetConnection.id;

  const scrolled = await evalIn(desktop, `(() => {
    const title = [...document.querySelectorAll('div')]
      .find((entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(targetName)} && entry.children.length === 0);
    const target = title?.parentElement?.parentElement?.parentElement;
    const list = target?.parentElement?.parentElement;
    if (!(list instanceof HTMLElement) || !(target instanceof HTMLElement)) return null;
    list.scrollTop = list.scrollHeight;
    const targetRect = target.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      scrollTop: list.scrollTop,
      targetVisible: targetRect.top >= listRect.top && targetRect.bottom <= listRect.bottom,
      actionVisible: [...target.querySelectorAll('button')]
        .some((button) => (button.textContent ?? "").trim() === "Connect your account"),
    };
  })()`);
  expect(scrolled).toMatchObject({ targetVisible: true, actionVisible: true });
  expect(isRecord(scrolled) && typeof scrolled.scrollTop === "number" ? scrolled.scrollTop : 0).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "The composer menu has a definite height and an independently scrolling connection list",
    `Overflow geometry before and after scrolling: ${JSON.stringify({ overflow, scrolled })}.`,
    isRecord(overflow)
      && typeof overflow.panelHeight === "number"
      && overflow.panelHeight > 180
      && overflow.navigationOverflow === "auto"
      && overflow.listOverflow === "auto"
      && overflow.targetInitiallyBelow === true
      && isRecord(scrolled)
      && scrolled.targetVisible === true,
  );

  const connectStartedAt = new Date().toISOString();
  const connectClicked = await evalIn(desktop, `(() => {
    const title = [...document.querySelectorAll('div')]
      .find((entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(targetName)} && entry.children.length === 0);
    const row = title?.parentElement?.parentElement?.parentElement;
    const action = row ? [...row.querySelectorAll('button')]
      .find((button) => (button.textContent ?? "").trim() === "Connect your account") : null;
    if (!(action instanceof HTMLButtonElement) || action.disabled) return false;
    action.click();
    return true;
  })()`);
  expect(connectClicked).toBe(true);
  const authorization = await den.mocks.connector.authorizeRequestSince(connectStartedAt);
  expect(authorization.params.get("state")).toBeTruthy();

  const connected = await eventually(
    async () => (await readUsableConnection(den.admin, targetId))?.connectedForMe === true,
    {
      within: 90_000,
      intervalMs: 1_000,
      label: "Den connection becomes ready after composer-row OAuth",
      until: (value) => value,
    },
  );
  expect(connected).toBe(true);
  await waitFor(desktop, `(() => {
    const title = [...document.querySelectorAll('div')]
      .find((entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(targetName)} && entry.children.length === 0);
    const row = title?.parentElement?.parentElement?.parentElement;
    return (row?.textContent ?? "").includes("Ready")
      && ![...(row?.querySelectorAll('button') ?? [])]
        .some((button) => (button.textContent ?? "").trim() === "Connect your account");
  })()`, {
    timeoutMs: 90_000,
    label: "composer connection row changes from sign-in to ready",
  });
  const readyRow = await evalIn(desktop, `(() => {
    const title = [...document.querySelectorAll('div')]
      .find((entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(targetName)} && entry.children.length === 0);
    const row = title?.parentElement?.parentElement?.parentElement;
    return {
      hasReady: (row?.textContent ?? "").includes("Ready"),
      hasSignIn: [...(row?.querySelectorAll('button') ?? [])]
        .some((button) => (button.textContent ?? "").trim() === "Connect your account"),
    };
  })()`);
  expect(readyRow).toEqual({ hasReady: true, hasSignIn: false });
  evidence.recordAssertionEvidence(
    "OAuth started from the composer row and the same Den connection became ready",
    `Connection ${targetId} reached Den connectedForMe=true and row state ${JSON.stringify(readyRow)}.`,
    connected === true
      && isRecord(readyRow)
      && readyRow.hasReady === true
      && readyRow.hasSignIn === false,
  );
});
