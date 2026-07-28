import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/markdown-table-live-preview.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("markdown-table-live-preview");

const DOC = `# Recovery objectives

| Service or obligation | Proposed RTO | Proposed RPO | Approval |
|---|---:|---:|---|
| Critical support intake | 4 hours | Not applicable | Joint |
| OpenWork server | 8 hours | 24 hours | Genpact |

Some prose between the two tables that should still wrap to the width of the panel.

| Role | Name |
|---|---|
| Plan owner | Benjamin Shafii |
`;

const NEW_ROW = "\\n| Security owner | [CONFIRM] |";

async function closeStaleDialogs(ctx) {
  await ctx.eval(`(() => {
    for (let index = 0; index < 3; index += 1) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    const active = document.activeElement;
    if (active && typeof active.blur === "function") active.blur();
    return true;
  })()`);
}

async function bootPrecondition(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
  await closeStaleDialogs(ctx);
  const state = await ctx.waitFor(
    `(() => {
      const route = String(window.__openworkControl.snapshot().route || "");
      if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
      const action = window.__openworkControl.listActions().find((item) => item.id === "session.create_task");
      return action && !action.disabled ? "ready" : null;
    })()`,
    { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" },
  );
  if (state === "blocked") return "Profile is not onboarded (welcome/signin); this flow needs a workspace.";
  return null;
}

/** Rendered tables plus any markdown source still visible as text. */
const READ_EDITOR = `(() => {
  const content = document.querySelector(".cm-editor .cm-content");
  if (!content) return { ok: false, reason: "markdown editor is not mounted" };
  const tables = Array.from(content.querySelectorAll("table"));
  const lines = Array.from(content.querySelectorAll(".cm-line")).map((line) => (line.textContent || "").trim());
  return {
    ok: true,
    tableCount: tables.length,
    pipeLines: lines.filter((text) => text.startsWith("|")).length,
    dividerLines: lines.filter((text) => /^\\|[\\s\\-:|]+\\|$/.test(text)).length,
    rightAlignedCells: content.querySelectorAll('[style*="text-align: right"]').length,
    headers: tables[0] ? Array.from(tables[0].querySelectorAll("th")).map((cell) => cell.textContent) : [],
    lastTableRows: tables.length
      ? Array.from(tables[tables.length - 1].querySelectorAll("tbody tr")).map((row) =>
          Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent))
      : [],
  };
})()`;

async function readEditor(ctx) {
  return ctx.waitFor(
    `(() => { const result = ${READ_EDITOR}; return result.ok ? result : null; })()`,
    { timeoutMs: 30_000, label: "markdown artifact editor" },
  );
}

async function openMarkdownArtifact(ctx) {
  const hasSession = await ctx.eval(`String(window.__openworkControl.snapshot().route || "").includes("/session/ses_")`);
  if (!hasSession) {
    await ctx.control("session.create_task");
    await ctx.waitFor(
      `String(window.__openworkControl.snapshot().route || "").includes("/session/ses_")`,
      { timeoutMs: 60_000, label: "session route after task creation" },
    );
  }

  // The artifact seed action is registered by the side panel, so the panel has
  // to be mounted before it can be called.
  const seedReady = `window.__openworkControl.listActions().some((item) => item.id === "eval.artifact_tabs.seed_overflow" && !item.disabled)`;
  if (!(await ctx.eval(seedReady))) {
    await ctx.eval(`(() => {
      const globe = Array.from(document.querySelectorAll("button"))
        .find((button) => (button.getAttribute("aria-label") || "").startsWith("Browser"));
      globe?.click();
      return Boolean(globe);
    })()`);
    await ctx.waitFor(seedReady, { timeoutMs: 30_000, label: "artifact seed action enabled" });
  }

  await ctx.control("eval.artifact_tabs.seed_overflow", { count: 12 });
  await ctx.waitFor(
    `document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]').length >= 12`,
    { timeoutMs: 30_000, label: "seeded artifact tabs" },
  );
  await ctx.eval(`(() => {
    const tabs = Array.from(document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]'));
    tabs[tabs.length - 1]?.click();
    return tabs.length;
  })()`);
  await ctx.waitFor(
    `Boolean(document.querySelector(".cm-editor .cm-content")) && Boolean(window.__artifactEditorView)`,
    { timeoutMs: 30_000, label: "markdown editor mounted" },
  );

  // Load the document and park the cursor outside every table.
  await ctx.eval(`(() => {
    const view = window.__artifactEditorView;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(DOC)} } });
    view.dispatch({ selection: { anchor: 0 } });
    return true;
  })()`);
}

export default {
  id: "markdown-table-live-preview",
  title: "Markdown tables render in the artifact editor while staying editable",
  kind: "user-facing",
  precondition: bootPrecondition,
  steps: [
    {
      name: "Tables render instead of showing pipes",
      run: async (ctx) => {
        await ctx.prove("Both markdown tables draw as real tables with their column alignment", {
          voiceover: vo[0],
          action: async () => {
            await closeStaleDialogs(ctx);
            await openMarkdownArtifact(ctx);
            await ctx.waitFor(
              `document.querySelectorAll(".cm-editor .cm-content table").length === 2`,
              { timeoutMs: 30_000, label: "both tables rendered" },
            );
          },
          assert: async () => {
            const editor = await readEditor(ctx);
            ctx.assert(editor.tableCount === 2, `Expected 2 rendered tables, got ${editor.tableCount}.`);
            ctx.assert(editor.pipeLines === 0, `Expected no raw pipe rows on screen, got ${editor.pipeLines}.`);
            ctx.assert(editor.dividerLines === 0, `The dashed divider row is still visible as text (${editor.dividerLines} line(s)).`);
            ctx.assert(
              editor.rightAlignedCells >= 6,
              `Expected the two right-aligned columns to keep their alignment, got ${editor.rightAlignedCells} right-aligned cells.`,
            );
            ctx.assert(
              editor.headers.join("|") === "Service or obligation|Proposed RTO|Proposed RPO|Approval",
              `Unexpected header cells: ${JSON.stringify(editor.headers)}.`,
            );
            ctx.log(`rendered ${editor.tableCount} tables, ${editor.rightAlignedCells} right-aligned cells`);
          },
          screenshot: {
            name: "tables-rendered",
            requireText: ["Recovery objectives", "Proposed RTO"],
            rejectText: ["|---|", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Clicking a table hands back its markdown",
      run: async (ctx) => {
        await ctx.prove("Clicking a table returns its source with the cursor on the clicked row", {
          voiceover: vo[1],
          action: async () => {
            // Click a body row, not the header, so the cursor position proves the
            // click landed on the row the user aimed at.
            const clicked = await ctx.eval(`(() => {
              const wrapper = document.querySelectorAll(".cm-md-table")[1];
              const row = wrapper.querySelectorAll("tbody tr")[0];
              const rect = row.getBoundingClientRect();
              row.querySelector("td").dispatchEvent(new MouseEvent("mousedown", {
                bubbles: true,
                clientX: rect.x + 20,
                clientY: rect.y + rect.height / 2,
              }));
              return Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent).join(" / ");
            })()`);
            ctx.log(`clicked row: ${clicked}`);
            await ctx.waitFor(
              `document.querySelectorAll(".cm-editor .cm-content table").length === 1`,
              { timeoutMs: 30_000, label: "clicked table back to source" },
            );
          },
          assert: async () => {
            const editor = await readEditor(ctx);
            ctx.assert(editor.tableCount === 1, `The untouched table should stay rendered; found ${editor.tableCount} tables.`);
            ctx.assert(editor.pipeLines >= 3, `Expected the clicked table's markdown source, got ${editor.pipeLines} pipe rows.`);
            const cursorLine = await ctx.eval(`(() => {
              const view = window.__artifactEditorView;
              return view.state.doc.lineAt(view.state.selection.main.head).text;
            })()`);
            ctx.assert(
              cursorLine.startsWith("| Plan owner"),
              `Expected the cursor on the clicked row's markdown, but it is on: "${cursorLine}".`,
            );
            ctx.log(`cursor landed on: ${cursorLine}`);
          },
          screenshot: {
            name: "clicked-table-shows-source",
            requireText: ["| Role | Name |"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "A typed row shows up in the rendered table",
      run: async (ctx) => {
        await ctx.prove("Adding a row in markdown and clicking away re-renders the table with it", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`(() => {
              const view = window.__artifactEditorView;
              const doc = view.state.doc;
              let insertAt = -1;
              for (let number = 1; number <= doc.lines; number += 1) {
                if (doc.line(number).text.startsWith("| Plan owner")) insertAt = doc.line(number).to;
              }
              if (insertAt < 0) return "row not found";
              view.dispatch({ changes: { from: insertAt, insert: "${NEW_ROW}" } });
              view.dispatch({ selection: { anchor: 0 } });
              return "typed";
            })()`);
            await ctx.waitFor(
              `document.querySelectorAll(".cm-editor .cm-content table").length === 2`,
              { timeoutMs: 30_000, label: "edited table rendered again" },
            );
          },
          assert: async () => {
            const editor = await readEditor(ctx);
            ctx.assert(editor.tableCount === 2, `Expected both tables rendered again, got ${editor.tableCount}.`);
            ctx.assert(editor.pipeLines === 0, `Expected no raw pipe rows after clicking away, got ${editor.pipeLines}.`);
            const rows = editor.lastTableRows.map((row) => row.join(" / "));
            ctx.assert(
              rows.some((row) => row.includes("Security owner") && row.includes("[CONFIRM]")),
              `The typed row is missing from the rendered table: ${JSON.stringify(rows)}.`,
            );
            ctx.log(`rendered rows: ${JSON.stringify(rows)}`);
            ctx.output("rendered-table-rows", JSON.stringify(editor.lastTableRows, null, 2));
          },
          screenshot: {
            name: "typed-row-rendered",
            requireText: ["Security owner"],
            rejectText: ["| Security owner |", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Arrow keys step into a table instead of over it",
      run: async (ctx) => {
        await ctx.prove("Arrowing down into a table, and up into its last row, opens its markdown", {
          voiceover: vo[3],
          action: async () => {
            // Both keyboard journeys run here because the assertion below has to
            // stay read-only (the frame screenshot is taken after it).
            const walk = await ctx.eval(`(async () => {
              const view = window.__artifactEditorView;
              const press = async (key) => {
                view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
                await new Promise((resolve) => setTimeout(resolve, 150));
                return view.state.doc.lineAt(view.state.selection.main.head).text;
              };

              view.dispatch({ selection: { anchor: 0 } });
              view.focus();
              await new Promise((resolve) => setTimeout(resolve, 150));
              const down = [];
              for (let step = 0; step < 3; step += 1) down.push(await press("ArrowDown"));

              view.dispatch({ selection: { anchor: view.state.doc.length } });
              await new Promise((resolve) => setTimeout(resolve, 150));
              const up = await press("ArrowUp");
              return { down, up };
            })()`, { awaitPromise: true });
            ctx.log(`arrow down walk: ${JSON.stringify(walk.down)}`);
            ctx.log(`arrow up landed on: ${walk.up}`);
            ctx.assert(
              walk.down.some((line) => line.startsWith("| Service or obligation")),
              `Arrow down skipped the table instead of entering it: ${JSON.stringify(walk.down)}.`,
            );
            ctx.assert(
              walk.up.startsWith("| Security owner"),
              `Arrow up should land on the table's last row, but landed on: "${walk.up}".`,
            );
          },
          assert: async () => {
            const editor = await readEditor(ctx);
            ctx.assert(
              editor.tableCount === 1,
              `Only the table holding the cursor should be source; found ${editor.tableCount} rendered tables.`,
            );
            ctx.assert(
              editor.pipeLines >= 4,
              `Expected the entered table's markdown on screen, got ${editor.pipeLines} pipe rows.`,
            );
            ctx.log(`${editor.tableCount} table still rendered, ${editor.pipeLines} pipe rows shown as source`);
          },
          screenshot: {
            name: "arrow-keys-enter-table",
            requireText: ["| Security owner |"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "A wide table does not stop the prose wrapping",
      run: async (ctx) => {
        await ctx.prove("The table scrolls in its own box instead of stretching the document", {
          voiceover: vo[4],
          action: async () => {
            // The previous frame left the cursor inside a table; move it out so
            // both tables are rendered again.
            await ctx.eval(`(() => {
              const view = window.__artifactEditorView;
              view.dispatch({ selection: { anchor: 0 } });
              return true;
            })()`);
            await ctx.waitFor(
              `Boolean(document.querySelector(".cm-editor .cm-scroller")) && document.querySelectorAll(".cm-md-table").length === 2`,
              { timeoutMs: 30_000, label: "both rendered tables present" },
            );
            // Scroll the wide table sideways to reveal its last column. If the
            // table were stretching the document this would scroll the whole
            // editor instead.
            await ctx.eval(`(() => {
              const wrapper = document.querySelectorAll(".cm-md-table")[0];
              wrapper.scrollLeft = wrapper.scrollWidth;
              return wrapper.scrollLeft;
            })()`);
            await ctx.waitFor(
              `document.querySelectorAll(".cm-md-table")[0].scrollLeft > 0`,
              { timeoutMs: 10_000, label: "table scrolled in place" },
            );
          },
          assert: async () => {
            const layout = await ctx.eval(`(() => {
              const scroller = document.querySelector(".cm-editor .cm-scroller");
              const content = document.querySelector(".cm-editor .cm-content");
              const wrapper = document.querySelectorAll(".cm-md-table")[0];
              const table = wrapper.querySelector("table");
              return {
                scrollerClient: scroller.clientWidth,
                scrollerScrollLeft: scroller.scrollLeft,
                contentWidth: content.offsetWidth,
                wrapperClient: wrapper.clientWidth,
                wrapperScroll: wrapper.scrollWidth,
                wrapperScrollLeft: wrapper.scrollLeft,
                tableWidth: table.offsetWidth,
              };
            })()`);
            ctx.assert(
              layout.contentWidth <= layout.scrollerClient + 1,
              `The table stretched the document: content is ${layout.contentWidth}px inside a ${layout.scrollerClient}px editor, so other paragraphs stop wrapping.`,
            );
            ctx.assert(
              layout.tableWidth > layout.wrapperClient,
              `This frame cannot witness the containment: the table (${layout.tableWidth}px) already fits its box (${layout.wrapperClient}px).`,
            );
            ctx.assert(
              layout.wrapperScroll > layout.wrapperClient,
              `The wide table is not scrollable in place (scrollWidth ${layout.wrapperScroll}px vs client ${layout.wrapperClient}px).`,
            );
            ctx.assert(
              layout.wrapperScrollLeft > 0,
              "Scrolling the table sideways had no effect, so its extra columns are unreachable.",
            );
            ctx.assert(
              layout.scrollerScrollLeft === 0,
              `Scrolling the table dragged the whole document sideways (editor scrollLeft ${layout.scrollerScrollLeft}px).`,
            );
            ctx.log(`editor ${layout.scrollerClient}px, content ${layout.contentWidth}px, table ${layout.tableWidth}px scrolled to ${layout.wrapperScrollLeft}px inside ${layout.wrapperClient}px`);
          },
          screenshot: {
            name: "wide-table-contained",
            requireText: ["wrap to the width of the panel"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
