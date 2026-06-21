const GROUP_LABEL = `Daytona Eval Group ${Date.now()}`;

async function pressCommandK(ctx) {
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    modifiers: 2,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: 2,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
  });
}

async function clickCommandItem(ctx, text) {
  await ctx.waitFor(
    `(() => [...document.querySelectorAll('[data-slot="command-item"]')].some((el) => (el.textContent ?? '').includes(${JSON.stringify(text)})))()`,
    { label: `command item ${text}` },
  );
  const clicked = await ctx.eval(`(() => {
    const item = [...document.querySelectorAll('[data-slot="command-item"]')]
      .find((el) => (el.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!item) return false;
    item.scrollIntoView({ block: 'center' });
    item.click();
    return true;
  })()`);
  ctx.assert(clicked === true, `Could not click command item: ${text}`);
}

export default {
  id: "session-command-palette-move-to-group",
  title: "Command palette moves the current session to a group",
  spec: "Command-K shows Move to Group, lists groups, and assigns the current session",
  steps: [
    {
      name: "Electron app and control API are ready",
      run: async (ctx) => {
        const userAgent = await ctx.eval("navigator.userAgent");
        ctx.assert(typeof userAgent === "string" && userAgent.includes("Electron/"), `Expected Electron userAgent, got: ${userAgent}`);
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "control API",
        });
        await ctx.waitFor(
          "window.__openworkControl.listActions().some((a) => a.id === 'session.create_task' && !a.disabled)",
          { timeoutMs: 60_000, label: "enabled task creation action" },
        );
      },
    },
    {
      name: "Create and select a current session",
      run: async (ctx) => {
        await ctx.control("session.create_task");
        const selected = await ctx.waitFor(`(() => {
          const route = window.__openworkControl.snapshot().route;
          const match = new RegExp('session/([^/?#]+)').exec(route);
          if (!match) return null;
          const sessionId = decodeURIComponent(match[1]);
          return { route, sessionId };
        })()`, { timeoutMs: 30_000, label: "selected session route" });
        ctx.assert(typeof selected.sessionId === "string" && selected.sessionId.length > 0, "No selected session id after task creation.");
        ctx.log(`selected session: ${JSON.stringify(selected)}`);
        await ctx.screenshot("session-selected");
      },
    },
    {
      name: "Create a group for the current workspace",
      run: async (ctx) => {
        const created = await ctx.control("session.group.create", { label: GROUP_LABEL });
        ctx.assert(created?.ok === true, `Group creation did not return ok: ${JSON.stringify(created)}`);
        ctx.assert(typeof created.groupId === "string" && created.groupId.length > 0, `No group id returned: ${JSON.stringify(created)}`);
        ctx.log(`created group: ${JSON.stringify(created)}`);
        await ctx.waitFor(
          `document.body.innerText.toLowerCase().includes(${JSON.stringify(GROUP_LABEL.toLowerCase())})`,
          { timeoutMs: 30_000, label: `visible group ${GROUP_LABEL}` },
        );
        await ctx.screenshot("group-created");
      },
    },
    {
      name: "Command-K shows Move to Group",
      run: async (ctx) => {
        await pressCommandK(ctx);
        await ctx.waitForText("Move to Group", { timeoutMs: 15_000 });
        const body = await ctx.eval("document.body.innerText");
        ctx.assert(body.includes("Move to Group"), "Command palette did not show Move to Group.");
        ctx.assert(body.includes("groups"), "Move to Group did not show the current group count.");
        await ctx.screenshot("command-k-move-to-group");
      },
    },
    {
      name: "Group list appears from Move to Group",
      run: async (ctx) => {
        await clickCommandItem(ctx, "Move to Group");
        await ctx.waitForText(GROUP_LABEL, { timeoutMs: 15_000 });
        const body = await ctx.eval("document.body.innerText");
        ctx.assert(body.includes("Move to Group"), "Group picker title is missing.");
        ctx.assert(body.includes(GROUP_LABEL), "Group picker did not list the created group.");
        await ctx.screenshot("group-list-visible");
      },
    },
    {
      name: "Selecting the group assigns the current session",
      run: async (ctx) => {
        await clickCommandItem(ctx, GROUP_LABEL);
        await ctx.waitFor(
          `(() => !document.body.innerText.includes('Search groups...'))()`,
          { timeoutMs: 15_000, label: "group picker closed" },
        );

        await pressCommandK(ctx);
        await clickCommandItem(ctx, "Move to Group");
        await ctx.waitFor(
          `(() => {
            const items = [...document.querySelectorAll('[data-slot="command-item"]')];
            const group = items.find((el) => (el.textContent ?? '').includes(${JSON.stringify(GROUP_LABEL)}));
            return Boolean(group && (group.textContent ?? '').includes('Current'));
          })()`,
          { timeoutMs: 15_000, label: "selected group marked Current" },
        );
        const groupItemText = await ctx.eval(`(() => {
          const group = [...document.querySelectorAll('[data-slot="command-item"]')]
            .find((el) => (el.textContent ?? '').includes(${JSON.stringify(GROUP_LABEL)}));
          return group ? group.textContent : '';
        })()`);
        ctx.assert(groupItemText.includes("Current"), `Expected selected group to be marked Current, got: ${groupItemText}`);
        ctx.log(`assigned group item text: ${groupItemText}`);
        await ctx.screenshot("group-assigned-current");
      },
    },
  ],
};
