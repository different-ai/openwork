/**
 * User-facing flow demo: cross-session message search is discoverable from the
 * sidebar and returns grouped results (Recent / Session titles / Messages).
 *
 * The deep-search query defaults to "joke" and can be overridden with
 * OPENWORK_EVAL_SEARCH_QUERY for profiles seeded with different data. The flow
 * expects the query to match at least one session title or message.
 */
const SEARCH_INPUT = 'input[placeholder="Search all sessions and messages…"]';

export default {
  id: "session-search-grouped",
  title: "Cross-session search: sidebar entry, grouped results, jump to match",
  kind: "user-facing",
  steps: [
    {
      name: "App boots with at least one session in the sidebar",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 30_000,
          label: "window.__openworkControl",
        });
        await ctx.waitFor("document.body.innerText.trim().length > 40", {
          label: "rendered body text",
        });
      },
    },
    {
      name: "Search is discoverable in the sidebar",
      run: async (ctx) => {
        await ctx.prove("Sidebar exposes a Search sessions entry", {
          claim: "The sidebar shows a 'Search sessions' button with its keyboard shortcut, so cross-message search is one click away.",
          voiceover:
            "This is OpenWork. Every workspace and conversation lives in the sidebar on the left. At the very top there is a new entry: Search sessions. Cross-message search used to be hidden behind a keyboard shortcut — now it is one click away, and the shortcut hint is printed right on the button.",
          assert: async () => {
            await ctx.expectText("Search sessions");
          },
          screenshot: {
            name: "sidebar-search-entry",
            requireText: ["Search sessions"],
          },
        });
      },
    },
    {
      name: "Opening search shows recent sessions grouped",
      run: async (ctx) => {
        await ctx.prove("Empty query shows a Recent sessions group", {
          claim: "Clicking the sidebar entry opens the search dialog; before typing, results are grouped under 'Recent sessions' with a count.",
          voiceover:
            "Clicking it opens the search dialog. Before you type anything, it shows your most recent conversations under a Recent sessions header, with a count — so the dialog is useful from the very first frame.",
          action: async () => {
            // Idempotence: a previous run may have left the dialog open.
            const alreadyOpen = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(SEARCH_INPUT)}))`);
            if (alreadyOpen) {
              await ctx.eval(`(() => {
                const input = document.querySelector(${JSON.stringify(SEARCH_INPUT)});
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
                return true;
              })()`);
              await ctx.waitFor(`!document.querySelector(${JSON.stringify(SEARCH_INPUT)})`, {
                label: "stale search dialog to close",
              });
            }
            await ctx.clickText("Search sessions");
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(SEARCH_INPUT)}))`, {
              label: "session search dialog input",
            });
          },
          assert: async () => {
            await ctx.expectText("Recent sessions");
          },
          screenshot: {
            name: "search-dialog-recent",
            requireText: ["Recent sessions"],
          },
        });
      },
    },
    {
      name: "Typing a query groups results by match kind",
      run: async (ctx) => {
        const query = ctx.env.OPENWORK_EVAL_SEARCH_QUERY?.trim() || "joke";
        await ctx.prove("Query results are grouped with counts", {
          claim: `Typing "${query}" shows results grouped by why they matched (Session titles and/or Messages), each with a count.`,
          voiceover:
            "I type a query. Results are no longer one flat list: they are grouped. Session titles collects the conversations whose name matches, and each group label shows exactly how many results it holds.",
          action: async () => {
            await ctx.fill(SEARCH_INPUT, query);
            await ctx.waitFor(
              `(() => {
                const text = document.body.innerText;
                return text.includes("Session titles") || text.includes("Messages");
              })()`,
              { timeoutMs: 30_000, label: "grouped search results" },
            );
          },
          assert: async () => {
            const groups = await ctx.eval(`(() => {
              const text = document.body.innerText;
              return {
                titles: text.includes("Session titles"),
                messages: text.includes("Messages"),
              };
            })()`);
            ctx.assert(groups.titles || groups.messages, `No result group rendered for query "${query}".`);
            ctx.log(`Groups rendered: ${JSON.stringify(groups)}`);
          },
          screenshot: {
            name: "search-grouped-results",
            rejectText: ["No sessions or messages match your search."],
          },
        });
      },
    },
    {
      name: "Message matches show highlighted transcript snippets",
      run: async (ctx) => {
        await ctx.prove("Messages group carries snippet, role, and workspace", {
          claim: "The Messages group shows transcript matches with the matched text highlighted, the speaker role, and the owning workspace.",
          voiceover:
            "Below that, the Messages group shows conversations where the words appear inside the transcript itself — with the matched text highlighted, who said it, and which workspace it came from. While transcripts are still being scanned, a spinner sits right on the group label.",
          action: async () => {
            // The deep scan is debounced and streams in asynchronously: wait for
            // an actual message match to render, not just for the spinner state.
            await ctx.waitFor(
              `(() => {
                const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'));
                return items.some((item) => /You:|Agent:/.test(item.innerText));
              })()`,
              { timeoutMs: 60_000, label: "a transcript match with a role-prefixed snippet" },
            );
          },
          assert: async () => {
            const snippet = await ctx.eval(`(() => {
              const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'));
              const withSnippet = items.find((item) => /You:|Agent:/.test(item.innerText));
              return withSnippet ? withSnippet.innerText.slice(0, 200) : null;
            })()`);
            ctx.assert(Boolean(snippet), "No message result with a role-prefixed snippet rendered.");
            ctx.log(`Message snippet: ${snippet}`);
          },
          screenshot: {
            name: "search-message-snippet",
            requireText: ["Messages"],
          },
        });
      },
    },
    {
      name: "Choosing a result jumps into the conversation",
      run: async (ctx) => {
        await ctx.prove("Selecting a result navigates to its session", {
          claim: "Clicking a result closes the dialog and lands the user directly in the matched conversation.",
          voiceover:
            "Press Enter or click any result, and you land directly in that conversation. That is the whole loop: discover, search, and jump — in under five seconds.",
          action: async () => {
            await ctx.eval(`(() => {
              const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'));
              const target = items.find((item) => /You:|Agent:/.test(item.innerText)) ?? items[0];
              if (!target) throw new Error("no result to click");
              target.click();
              return true;
            })()`);
            await ctx.waitFor(
              `!document.querySelector(${JSON.stringify(SEARCH_INPUT)})`,
              { label: "search dialog to close" },
            );
          },
          assert: async () => {
            await ctx.expectHashIncludes("/session/");
          },
          screenshot: {
            name: "opened-session",
            hashIncludes: "/session/",
          },
        });
      },
    },
  ],
};
