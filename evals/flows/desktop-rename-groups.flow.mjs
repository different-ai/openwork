import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("desktop-rename-groups");
const RUN_SUFFIX = Date.now().toString().slice(-5);
const PRIMARY_LABEL = `Product Group ${RUN_SUFFIX}`;
const RENAMED_LABEL = `Renamed Group ${RUN_SUFFIX}`;
const DESTINATION_LABEL = `Archive Group ${RUN_SUFFIX}`;

let primaryGroupId = "";
let destinationGroupId = "";

async function scrollGroupIntoView(ctx, groupId) {
  const scrolled = await ctx.eval(`(() => {
    const row = document.querySelector('[data-session-group="${groupId}"]');
    const sidebar = document.querySelector('[data-slot="sidebar-content"]');
    if (!row || !sidebar) return false;
    sidebar.scrollTop = Math.max(0, row.offsetTop - sidebar.clientHeight / 2);
    return true;
  })()`);
  ctx.assert(scrolled === true, `Could not reveal group ${groupId}`);
  await ctx.eval("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}

async function clickMatchingText(ctx, selector, text) {
  const point = await ctx.eval(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}));
    if (!element) return null;
    element.scrollIntoView({ block: "nearest" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  ctx.assert(point, `Could not click ${text}`);
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
  await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
}

async function expandGroupActions(ctx, groupId) {
  await scrollGroupIntoView(ctx, groupId);
  const actions = `[data-session-group-actions="${groupId}"]`;
  const expandedSelector = `${actions} button[aria-label="Rename Group"]`;
  const alreadyExpanded = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(expandedSelector)}))`);
  if (alreadyExpanded) return;
  const hovered = await ctx.eval(`(() => {
    const ellipsis = document.querySelector(${JSON.stringify(`${actions} button[aria-label="Group actions"]`)});
    if (!ellipsis) return false;
    ellipsis.scrollIntoView({ block: "center" });
    ellipsis.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return true;
  })()`);
  ctx.assert(hovered === true, "Could not hover the group ellipsis");
  await ctx.waitFor(
    `Boolean(document.querySelector(${JSON.stringify(expandedSelector)}))`,
    { label: "expanded group actions" },
  );
  await ctx.eval("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}

async function clickGroupAction(ctx, groupId, label) {
  const selector = `[data-session-group-actions="${groupId}"] button[aria-label="${label}"]`;
  const clicked = await ctx.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  ctx.assert(clicked === true, `Could not click ${label} for ${groupId}`);
}

export default {
  id: "desktop-rename-groups",
  title: "Session groups can be created, renamed, and deleted from one compact sidebar control",
  kind: "user-facing",
  steps: [
    {
      name: "Prepare grouped sessions",
      run: async (ctx) => {
        await ctx.client.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await ctx.client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
        await ctx.waitFor(
          "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
          { timeoutMs: 60_000, label: "enabled task creation" },
        );

        const primary = await ctx.control("session.group.create", { label: PRIMARY_LABEL });
        const destination = await ctx.control("session.group.create", { label: DESTINATION_LABEL });
        primaryGroupId = primary.groupId;
        destinationGroupId = destination.groupId;
        ctx.assert(primaryGroupId && destinationGroupId, "Could not create fixture groups");

        await ctx.control("session.create_task");
        const sessionId = await ctx.waitFor(`(() => {
          const match = new RegExp('session/([^/?#]+)').exec(window.__openworkControl.snapshot().route);
          return match ? decodeURIComponent(match[1]) : null;
        })()`, { timeoutMs: 30_000, label: "created session" });
        await ctx.control("session.group.move", { sessionId, groupId: primaryGroupId });
        await ctx.waitFor(`document.body.textContent.includes(${JSON.stringify(PRIMARY_LABEL)})`, { timeoutMs: 30_000, label: "visible primary group" });
      },
    },
    {
      name: "Count is flush right",
      run: async (ctx) => {
        await ctx.prove("The session count occupies the far-right edge without reserved delete-button space", {
          voiceover: vo[0],
          assert: async () => {
            await scrollGroupIntoView(ctx, primaryGroupId);
            const alignment = await ctx.eval(`(() => {
              const row = document.querySelector('[data-session-group="${primaryGroupId}"]');
              const count = row?.querySelector('[data-session-group-count]');
              if (!row || !count) return null;
              return Math.round(row.getBoundingClientRect().right - count.getBoundingClientRect().right);
            })()`);
            ctx.assert(alignment !== null && alignment <= 9, `Count was ${alignment}px from the row edge`);
          },
          screenshot: { name: "group-count-right", requireText: [PRIMARY_LABEL.toUpperCase(), "1"] },
        });
      },
    },
    {
      name: "Hover reveals compact actions",
      run: async (ctx) => {
        await ctx.prove("Hovering the ellipsis expands plus, rename, and delete actions", {
          voiceover: vo[1],
          action: async () => expandGroupActions(ctx, primaryGroupId),
          assert: async () => {
            const labels = await ctx.eval(`[
              ...document.querySelectorAll('[data-session-group-actions="${primaryGroupId}"] button')
            ].map((button) => button.getAttribute('aria-label'))`);
            ctx.assert(labels.includes("New session in group"), "Plus action is missing");
            ctx.assert(labels.includes("Rename Group"), "Rename action is missing");
            ctx.assert(labels.includes("Delete Group"), "Delete action is missing");
          },
          screenshot: { name: "group-actions-expanded", requireText: [PRIMARY_LABEL.toUpperCase()] },
        });
      },
    },
    {
      name: "Create a session in the group",
      run: async (ctx) => {
        await ctx.prove("The plus action creates and assigns a new session to this group", {
          voiceover: vo[2],
          action: async () => {
            await expandGroupActions(ctx, primaryGroupId);
            await clickGroupAction(ctx, primaryGroupId, "New session in group");
            await ctx.waitFor(
              `document.querySelector('[data-session-group="${primaryGroupId}"] [data-session-group-count]')?.textContent?.trim() === '2'`,
              { timeoutMs: 30_000, label: "group count increment" },
            );
          },
          assert: async () => {
            const count = await ctx.eval(`document.querySelector('[data-session-group="${primaryGroupId}"] [data-session-group-count]')?.textContent?.trim()`);
            ctx.assert(count === "2", `Expected two grouped sessions, got ${count}`);
          },
          screenshot: { name: "new-session-in-group", requireText: [PRIMARY_LABEL.toUpperCase(), "2"] },
        });
      },
    },
    {
      name: "Rename the group",
      run: async (ctx) => {
        await ctx.prove("Rename Group is pre-filled and saving updates the sidebar", {
          voiceover: vo[3],
          action: async () => {
            await expandGroupActions(ctx, primaryGroupId);
            await clickGroupAction(ctx, primaryGroupId, "Rename Group");
            const input = 'input[aria-label="Group name"]';
            await ctx.waitFor(`document.querySelector(${JSON.stringify(input)})?.value === ${JSON.stringify(PRIMARY_LABEL)}`, { label: "prefilled group name" });
            await ctx.fill(input, RENAMED_LABEL);
            await ctx.clickText("Save");
            await ctx.waitFor(`document.body.textContent.includes(${JSON.stringify(RENAMED_LABEL)})`, { label: "renamed group" });
            await expandGroupActions(ctx, primaryGroupId);
            await clickGroupAction(ctx, primaryGroupId, "Rename Group");
          },
          assert: async () => {
            await ctx.expectText("Rename Group");
            await ctx.expectText("Cancel");
            await ctx.expectText("Save");
            const value = await ctx.eval('document.querySelector(\'input[aria-label="Group name"]\')?.value');
            ctx.assert(value === RENAMED_LABEL, `Expected renamed value, got ${value}`);
          },
          screenshot: { name: "rename-group-dialog", requireText: ["Rename Group", "Cancel", "Save"] },
        });
      },
    },
    {
      name: "Choose a delete destination",
      run: async (ctx) => {
        await ctx.prove("Delete Group offers every other group and Ungrouped as destinations", {
          voiceover: vo[4],
          action: async () => {
            await ctx.clickText("Cancel");
            await expandGroupActions(ctx, primaryGroupId);
            await clickGroupAction(ctx, primaryGroupId, "Delete Group");
            const opened = await ctx.eval(`(() => {
              const trigger = document.querySelector('[role="dialog"] [data-slot="select-trigger"]');
              if (!trigger) return false;
              trigger.click();
              return true;
            })()`);
            ctx.assert(opened === true, "Could not open the destination picker");
            await ctx.waitFor("Boolean(document.querySelector('[data-slot=\"select-content\"]'))", { label: "destination picker" });
            await clickMatchingText(ctx, '[data-slot="select-item"]', DESTINATION_LABEL);
            await ctx.waitFor(
              `document.querySelector('[role="dialog"] [data-destination-group-id]')?.getAttribute('data-destination-group-id') === ${JSON.stringify(destinationGroupId)}`,
              { label: "selected destination group" },
            );
          },
          assert: async () => {
            await ctx.expectText("Delete Group");
            await ctx.expectText("Move sessions to");
            await ctx.expectText("Cancel");
            await ctx.expectText("Confirm");
            await ctx.expectText(DESTINATION_LABEL);
          },
          screenshot: { name: "delete-group-dialog", requireText: ["Delete Group", "Move sessions to", DESTINATION_LABEL, "Cancel", "Confirm"] },
        });
      },
    },
    {
      name: "Delete and move sessions",
      run: async (ctx) => {
        await ctx.prove("Confirming removes the group and moves its sessions to the selected destination", {
          voiceover: vo[5],
          action: async () => {
            await ctx.clickText("Confirm");
            await ctx.waitFor(`!document.body.textContent.includes(${JSON.stringify(RENAMED_LABEL)})`, { timeoutMs: 30_000, label: "deleted group removed" });
            await ctx.waitFor(
              `document.querySelector('[data-session-group="${destinationGroupId}"] [data-session-group-count]')?.textContent?.trim() === '2'`,
              { timeoutMs: 30_000, label: "sessions moved to destination" },
            );
          },
          assert: async () => {
            const removed = await ctx.eval(`!document.body.textContent.includes(${JSON.stringify(RENAMED_LABEL)})`);
            ctx.assert(removed === true, "Deleted group is still visible");
            const count = await ctx.eval(`document.querySelector('[data-session-group="${destinationGroupId}"] [data-session-group-count]')?.textContent?.trim()`);
            ctx.assert(count === "2", `Expected two moved sessions, got ${count}`);
          },
          screenshot: { name: "group-deleted-sessions-moved", requireText: [DESTINATION_LABEL.toUpperCase(), "2"], rejectText: [RENAMED_LABEL.toUpperCase()] },
        });
      },
    },
  ],
};
