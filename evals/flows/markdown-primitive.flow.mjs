import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/markdown-primitive.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("markdown-primitive");

const CHAT_SEED_ACTION = "eval.markdown_primitive.seed_chat";
const ARTIFACT_SEED_ACTION = "eval.markdown_primitive.seed_artifact";
const FIND_INPUT = 'input[aria-label="Find in conversation"]';
const HIGHLIGHT_QUERY = "primitive";

let activeSessionId = "";
let assistantMessageId = "";
let transcriptBeforeFind = "";

function messageSelector(messageId) {
  return `[data-message-id=${JSON.stringify(messageId)}]`;
}

async function closeTransientUi(ctx) {
  await ctx.eval(`(() => {
    const closeFind = document.querySelector('button[aria-label="Close find"]');
    if (closeFind instanceof HTMLButtonElement && !closeFind.disabled) {
      closeFind.click();
    }

    for (let index = 0; index < 3; index += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    return true;
  })()`);
  await ctx.waitFor(
    `!document.querySelector(${JSON.stringify(FIND_INPUT)}) && !document.querySelector('mark[data-search-highlight="true"]')`,
    { timeoutMs: 30_000, label: "find UI and search highlights to clear" },
  );
}

async function waitForControl(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
}

async function activeSessionFromRoute(ctx) {
  return ctx.eval(`(() => {
    const route = String(window.__openworkControl.snapshot().route || window.location.hash || "");
    const match = route.match(/ses_[A-Za-z0-9]+/);
    return match ? match[0] : "";
  })()`);
}

async function ensureSession(ctx) {
  await waitForControl(ctx);
  await closeTransientUi(ctx);

  const routeSession = await activeSessionFromRoute(ctx);
  if (routeSession) {
    activeSessionId = routeSession;
    return routeSession;
  }

  const sessions = await ctx.control("session.list_sessions").catch(() => []);
  const firstSession = Array.isArray(sessions) ? sessions[0] : null;
  if (firstSession?.sessionId) {
    await ctx.control("session.open", { sessionId: firstSession.sessionId });
    await ctx.waitFor(
      `String(window.__openworkControl.snapshot().route || "").includes(${JSON.stringify(firstSession.sessionId)})`,
      { timeoutMs: 30_000, label: "existing session route" },
    );
    activeSessionId = firstSession.sessionId;
    return firstSession.sessionId;
  }

  await ctx.control("session.create_task");
  const createdSession = await ctx.waitFor(
    `(() => {
      const route = String(window.__openworkControl.snapshot().route || "");
      const match = route.match(/ses_[A-Za-z0-9]+/);
      return match ? match[0] : null;
    })()`,
    { timeoutMs: 30_000, label: "created session route" },
  );
  activeSessionId = createdSession;
  return createdSession;
}

async function ensureActionEnabled(ctx, actionId) {
  await ctx.waitFor(
    `window.__openworkControl.listActions().some((action) => action.id === ${JSON.stringify(actionId)} && !action.disabled)`,
    { timeoutMs: 30_000, label: `${actionId} enabled` },
  );
}

async function mountArtifactPanel(ctx) {
  const ready = await ctx.eval(
    `window.__openworkControl.listActions().some((action) => action.id === ${JSON.stringify(ARTIFACT_SEED_ACTION)} && !action.disabled)`,
  );
  if (ready) return;

  await ctx.eval(`(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((item) => item.getAttribute("aria-label") === "Browser" && !item.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  await ensureActionEnabled(ctx, ARTIFACT_SEED_ACTION);
}

export default {
  id: "markdown-primitive",
  title: "One supported Markdown pipeline across chat and supporting surfaces",
  kind: "user-facing",
  precondition: async (ctx) => {
    await waitForControl(ctx);
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const route = String(control.snapshot().route || "");
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        if (route.includes("/session/")) return "ready";
        const create = control.listActions().find((action) => action.id === "session.create_task");
        return create && !create.disabled ? "ready" : null;
      })()`,
      { timeoutMs: 30_000, label: "session route or create_task enabled" },
    );

    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); markdown primitive proof requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Conversation opens normally",
      run: async (ctx) => {
        await ctx.prove("OpenWork displays a normal session before the Markdown proof starts", {
          voiceover: vo[0],
          action: async () => {
            await ensureSession(ctx);
            await ctx.waitFor("document.body.innerText.trim().length > 40", {
              label: "rendered app text",
            });
          },
          assert: async () => {
            ctx.assert(Boolean(activeSessionId), "No active session id was available.");
            await ctx.expectHashIncludes("/session/");
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "conversation-open",
            hashIncludes: "/session/",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Chat Markdown renders supported formatting",
      run: async (ctx) => {
        await ctx.prove("The chat transcript renders Markdown headings, emphasis, inline code, code blocks, and links", {
          voiceover: vo[1],
          action: async () => {
            await ensureActionEnabled(ctx, CHAT_SEED_ACTION);
            const seeded = await ctx.control(CHAT_SEED_ACTION);
            assistantMessageId = seeded.assistantMessageId || "";
            ctx.assert(Boolean(assistantMessageId), `Seed action did not return an assistant message id: ${JSON.stringify(seeded)}`);
            await ctx.control("session.scroll_bottom").catch(() => undefined);
            await ctx.waitFor(
              `Boolean(document.querySelector(${JSON.stringify(messageSelector(assistantMessageId))}))`,
              { timeoutMs: 30_000, label: "seeded markdown assistant message" },
            );
            await ctx.waitForText("Markdown proof heading", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const selector = messageSelector(assistantMessageId);
            const rendered = await ctx.eval(`(() => {
              const root = document.querySelector(${JSON.stringify(selector)});
              if (!root) return { ok: false, reason: "seeded message not found" };
              return {
                ok: true,
                hasHeading: Boolean(root.querySelector("h1")),
                hasStrong: Boolean(root.querySelector("strong")),
                hasInlineCode: Boolean(root.querySelector("p code")),
                hasCodeBlock: Boolean(root.querySelector("[data-openwork-code-block] code")),
                hasLink: Boolean(root.querySelector('a[href="https://openworklabs.com"]')),
                hasCopyButton: Boolean(root.querySelector("[data-openwork-code-copy]")),
                text: root.innerText,
              };
            })()`);
            ctx.assert(rendered.ok, rendered.reason || "Markdown message did not render.");
            ctx.assert(rendered.hasHeading, "Heading was not rendered as an h1.");
            ctx.assert(rendered.hasStrong, "Bold text was not rendered as strong text.");
            ctx.assert(rendered.hasInlineCode, "Inline code was not rendered as a code element.");
            ctx.assert(rendered.hasCodeBlock, "Fenced code block was not rendered by the chat Markdown renderer.");
            ctx.assert(rendered.hasLink, "Markdown link was not rendered as an external anchor.");
            ctx.assert(rendered.hasCopyButton, "Chat code block lost its copy affordance.");
            ctx.log(`rendered markdown text: ${rendered.text.slice(0, 180)}`);
          },
          screenshot: {
            name: "chat-markdown-rendered",
            requireText: ["Markdown proof heading", "bold proof text", "OpenWork link"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Find highlights rendered Markdown text",
      run: async (ctx) => {
        await ctx.prove("Find in conversation highlights matching text inside rendered Markdown without mutating the transcript", {
          voiceover: vo[2],
          action: async () => {
            const before = await ctx.control("session.read_transcript", { count: 5 });
            transcriptBeforeFind = JSON.stringify(before);
            await ctx.eval(`(() => {
              const isMac = /Mac/i.test(navigator.platform || "");
              window.dispatchEvent(new KeyboardEvent("keydown", {
                key: "f",
                metaKey: isMac,
                ctrlKey: !isMac,
                bubbles: true,
                cancelable: true,
              }));
              return true;
            })()`);
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(FIND_INPUT)}))`, {
              timeoutMs: 30_000,
              label: "find input",
            });
            await ctx.fill(FIND_INPUT, HIGHLIGHT_QUERY);
            const selector = `${messageSelector(assistantMessageId)} mark[data-search-highlight="true"]`;
            await ctx.waitFor(
              `document.querySelectorAll(${JSON.stringify(selector)}).length > 0`,
              { timeoutMs: 30_000, label: "markdown search highlights" },
            );
          },
          assert: async () => {
            const selector = `${messageSelector(assistantMessageId)} mark[data-search-highlight="true"]`;
            const highlight = await ctx.eval(`(() => {
              const marks = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
              return {
                count: marks.length,
                labels: marks.map((mark) => mark.textContent || ""),
              };
            })()`);
            ctx.assert(highlight.count > 0, "No search highlight marks were found inside the rendered Markdown message.");
            ctx.assert(
              highlight.labels.every((label) => label.toLowerCase().includes(HIGHLIGHT_QUERY)),
              `Unexpected highlight labels: ${JSON.stringify(highlight.labels)}`,
            );

            const after = await ctx.control("session.read_transcript", { count: 5 });
            ctx.assert(JSON.stringify(after) === transcriptBeforeFind, "Search highlighting mutated the session transcript data.");
            ctx.log(`highlight labels: ${JSON.stringify(highlight.labels)}`);
          },
          screenshot: {
            name: "markdown-search-highlighted",
            requireText: ["markdown-primitive-highlight", "Copy code block"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Outside-chat Markdown remains readable and safe",
      run: async (ctx) => {
        await ctx.prove("A Markdown artifact preview renders readable formatted content outside the chat", {
          voiceover: vo[3],
          action: async () => {
            await closeTransientUi(ctx);
            await mountArtifactPanel(ctx);
            const seeded = await ctx.control(ARTIFACT_SEED_ACTION);
            ctx.assert(seeded.ok, `Artifact seed failed: ${JSON.stringify(seeded)}`);
            await ctx.waitForText("Artifact Markdown Proof", { timeoutMs: 30_000 });
            await ctx.waitForText("outside-chat Markdown", { timeoutMs: 30_000 });
            await ctx.waitFor(
              `Boolean(document.querySelector('[data-openwork-markdown-preview]'))`,
              { timeoutMs: 30_000, label: "markdown preview root" },
            );
          },
          assert: async () => {
            const rendered = await ctx.eval(`(() => {
              const preview = document.querySelector('[data-openwork-markdown-preview]');
              if (!preview) return { ok: false, reason: "markdown preview root missing" };
              const artifactTab = Array.from(document.querySelectorAll("button"))
                .find((button) => (button.getAttribute("aria-label") || "").includes("markdown-primitive-proof.md"));
              const h1 = Array.from(preview.querySelectorAll("h1"))
                .find((node) => (node.textContent || "").trim() === "Artifact Markdown Proof");
              const strong = Array.from(preview.querySelectorAll("strong"))
                .find((node) => (node.textContent || "").includes("outside-chat Markdown"));
              const externalAnchor = Array.from(preview.querySelectorAll("a"))
                .find((node) => node.getAttribute("href") === "https://openworklabs.com");
              const shikiCode = Array.from(preview.querySelectorAll('[data-openwork-shiki] code'))
                .find((node) => (node.textContent || "").includes("shared markdown primitive"));
              const fallbackCode = Array.from(preview.querySelectorAll("pre code"))
                .find((node) => {
                  const pre = node.closest("pre");
                  return Boolean(pre && pre.className.includes("border-dls-border/70") && (node.textContent || "").includes("shared markdown primitive"));
                });
              return {
                ok: true,
                hasArtifactTab: Boolean(artifactTab),
                hasRenderedHeading: Boolean(h1),
                hasRenderedStrong: Boolean(strong),
                hasExternalAnchor: Boolean(externalAnchor),
                hasSurfaceCodeBlock: Boolean(shikiCode || fallbackCode),
                hasChatCopyButton: Boolean(preview.querySelector("[data-openwork-code-copy]")),
              };
            })()`);
            ctx.assert(rendered.ok, rendered.reason || "Markdown preview root was not available.");
            ctx.assert(rendered.hasArtifactTab, "The markdown artifact tab was not visible.");
            ctx.assert(rendered.hasRenderedHeading, "Artifact Markdown heading was not rendered as an h1 in MarkdownPreview.");
            ctx.assert(rendered.hasRenderedStrong, "Artifact Markdown bold text was not rendered as strong text in MarkdownPreview.");
            ctx.assert(rendered.hasExternalAnchor, "Artifact Markdown link was not rendered as an external anchor in MarkdownPreview.");
            ctx.assert(rendered.hasSurfaceCodeBlock, "Artifact Markdown code block was not rendered by the surface Markdown renderer.");
            ctx.assert(!rendered.hasChatCopyButton, "Surface MarkdownPreview rendered the chat-only code copy affordance.");
          },
          screenshot: {
            name: "outside-chat-markdown-safe",
            requireText: ["markdown-primitive-proof.md", "Artifact Markdown Proof", "outside-chat Markdown"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
