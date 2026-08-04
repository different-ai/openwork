import {
  createSession,
  ensureSessionWorkspace,
} from "./lib/session-workspace.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const READ_SHORTCUT_ROWS = `(() => [...document.querySelectorAll('[aria-keyshortcuts]')]
  .map((entry) => ({
    shortcut: entry.getAttribute('aria-keyshortcuts'),
    label: (entry.getAttribute('aria-label') || entry.textContent || '').trim(),
    visible: Boolean(entry.getClientRects().length),
  }))
  .filter((entry) => entry.visible && /(?:Meta|Control)\\+[1-9]/.test(entry.shortcut || '')))()`;
const READ_SHORTCUT_TARGETS = `(() => [...document.querySelectorAll('[data-sidebar-session-id]')]
  .flatMap((row) => {
    const button = row.querySelector('[data-session-tab-id][aria-keyshortcuts]');
    const shortcut = button?.getAttribute('aria-keyshortcuts') || '';
    const match = shortcut.match(/(?:Meta|Control)\\+([1-9])/);
    const sessionId = row.getAttribute('data-sidebar-session-id') || '';
    return button && button.getClientRects().length && match && sessionId
      ? [{ digit: Number(match[1]), sessionId }]
      : [];
  }))()`;
const READ_VISIBLE_SHORTCUT_BADGES =
  `(() => [...document.querySelectorAll('[data-session-shortcut-badge]')]
    .filter((entry) => entry.getClientRects().length > 0).length)()`;
const READ_VISIBLE_SHORTCUT_SLOTS =
  `(() => [...document.querySelectorAll('[data-session-action-slot="number-shortcut"]')]
    .filter((entry) => entry.getClientRects().length > 0).length)()`;
const vo = await loadVoiceoverParagraphs("sidebar-session-number-shortcuts");

async function dispatchKey(ctx, payload) {
  let timeout;
  try {
    await Promise.race([
      ctx.client.send("Input.dispatchKeyEvent", payload),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out dispatching ${payload.type} for ${payload.key}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function activateDifferentVisibleSession(ctx, modifier) {
  const currentSessionId = await ctx.eval(
    "window.__openwork?.slice?.('route')?.selectedSessionId || ''",
  );
  await dispatchKey(ctx, {
    type: "keyDown",
    key: modifier.key,
    code: modifier.code,
    modifiers: modifier.modifiers,
  });
  try {
    await ctx.waitFor(`${READ_SHORTCUT_TARGETS}.length >= 2`, {
      timeoutMs: 20_000,
      label: "at least two numbered session targets",
    });
    const targets = await ctx.eval(READ_SHORTCUT_TARGETS);
    const target = targets.find((entry) => entry.sessionId !== currentSessionId);
    ctx.assert(Boolean(target), `Expected a numbered target other than ${currentSessionId}.`);
    await dispatchKey(ctx, {
      type: "keyDown",
      key: String(target.digit),
      code: `Digit${target.digit}`,
      modifiers: modifier.modifiers,
      windowsVirtualKeyCode: 48 + target.digit,
      nativeVirtualKeyCode: 48 + target.digit,
    });
    await dispatchKey(ctx, {
      type: "keyUp",
      key: String(target.digit),
      code: `Digit${target.digit}`,
      modifiers: modifier.modifiers,
      windowsVirtualKeyCode: 48 + target.digit,
      nativeVirtualKeyCode: 48 + target.digit,
    });
    await ctx.waitFor(
      `window.__openwork?.slice?.('route')?.selectedSessionId === ${JSON.stringify(target.sessionId)}`,
      { timeoutMs: 20_000, label: `session ${target.digit} to open` },
    );
    return target;
  } finally {
    await dispatchKey(ctx, {
      type: "keyUp",
      key: modifier.key,
      code: modifier.code,
    });
  }
}

export default {
  id: "sidebar-session-number-shortcuts",
  title: "Platform-modifier number shortcuts match visible session order",
  kind: "user-facing",
  steps: [
    {
      name: "Holding the platform modifier reveals accurate first-nine session shortcuts",
      run: async (ctx) => {
        await ensureSessionWorkspace(
          ctx,
          "sidebar-session-number-shortcuts",
        );
        for (let index = 1; index <= 3; index += 1) {
          const sessionId = await createSession(ctx, `created session ${index}`);
          await ctx.control("session.rename", {
            sessionId,
            title: `Shortcut proof chat ${index}`,
          });
        }

        const isMac = await ctx.eval("navigator.platform.toLowerCase().includes('mac')");
        const modifier = {
          key: isMac ? "Meta" : "Control",
          code: isMac ? "MetaLeft" : "ControlLeft",
          modifiers: isMac ? 4 : 2,
        };
        await dispatchKey(ctx, {
          type: "keyDown",
          key: modifier.key,
          code: modifier.code,
          modifiers: modifier.modifiers,
        });
        try {
          await ctx.waitFor(`${READ_SHORTCUT_ROWS}.length >= 3`, {
            timeoutMs: 20_000,
            label: "numbered visible session rows",
          });

          await ctx.prove("Modifier badges appear without changing layout and expose accessible shortcuts", {
            voiceover: vo[0],
            action: async () => {},
            assert: async () => {
              const rows = await ctx.eval(READ_SHORTCUT_ROWS);
              ctx.assert(rows.length >= 3, `Expected at least three numbered rows, got ${JSON.stringify(rows)}.`);
              const firstNine = rows.slice(0, 9).map((entry) => entry.shortcut);
              ctx.assert(new Set(firstNine).size === firstNine.length, "Visible session shortcuts must be unique.");
              ctx.assert(
                firstNine.every((shortcut, index) => shortcut.endsWith(`+${index + 1}`)),
                `Shortcut numbering did not match visible order: ${JSON.stringify(firstNine)}.`,
              );
            },
            screenshot: {
              name: "sidebar-session-number-shortcuts-held",
              requireText: ["Shortcut proof chat"],
            },
          });
        } finally {
          await dispatchKey(ctx, {
            type: "keyUp",
            key: modifier.key,
            code: modifier.code,
          });
        }

        let composerTarget;
        await ctx.prove("The numbered session jump works while the composer owns focus", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(
              "Boolean(document.querySelector('[contenteditable=\"true\"][aria-placeholder]'))",
              { timeoutMs: 20_000, label: "composer editor" },
            );
            const focused = await ctx.eval(`(() => {
              const editor = document.querySelector('[contenteditable="true"][aria-placeholder]');
              editor?.focus();
              return document.activeElement === editor;
            })()`);
            ctx.assert(focused, "Expected the composer editor to own keyboard focus.");
            composerTarget = await activateDifferentVisibleSession(ctx, modifier);
          },
          assert: async () => {
            const selectedSessionId = await ctx.eval(
              "window.__openwork?.slice?.('route')?.selectedSessionId || ''",
            );
            ctx.assert(
              selectedSessionId === composerTarget?.sessionId,
              `Expected composer shortcut to open ${composerTarget?.sessionId}, got ${selectedSessionId}.`,
            );
          },
          screenshot: {
            name: "sidebar-session-number-shortcuts-composer",
            requireText: ["Shortcut proof chat"],
            hashIncludes: "/session/",
          },
        });

        let selectTarget;
        await ctx.prove("The numbered session jump works while the model select is open", {
          voiceover: vo[2],
          action: async () => {
            const opened = await ctx.eval(`(() => {
              const trigger = document.querySelector('[aria-label="Change model"]');
              trigger?.click();
              return Boolean(trigger);
            })()`);
            ctx.assert(opened, "Expected the Change model trigger to be available.");
            await ctx.waitFor(
              `(() => {
                const input = document.querySelector('input[placeholder="Search models..."]');
                return Boolean(input && input.getClientRects().length && document.activeElement === input);
              })()`,
              { timeoutMs: 20_000, label: "open model select search input" },
            );
            selectTarget = await activateDifferentVisibleSession(ctx, modifier);
          },
          assert: async () => {
            const selectedSessionId = await ctx.eval(
              "window.__openwork?.slice?.('route')?.selectedSessionId || ''",
            );
            ctx.assert(
              selectedSessionId === selectTarget?.sessionId,
              `Expected select-open shortcut to open ${selectTarget?.sessionId}, got ${selectedSessionId}.`,
            );
          },
          screenshot: {
            name: "sidebar-session-number-shortcuts-select",
            requireText: ["Shortcut proof chat"],
            hashIncludes: "/session/",
          },
        });

        await ctx.prove("A later unmodified pointer event clears a missed modifier release", {
          voiceover: vo[3],
          action: async () => {
            await activateDifferentVisibleSession(ctx, modifier);
            await dispatchKey(ctx, {
              type: "keyDown",
              key: modifier.key,
              code: modifier.code,
              modifiers: modifier.modifiers,
            });
            await ctx.waitFor(`${READ_VISIBLE_SHORTCUT_BADGES} >= 3`, {
              timeoutMs: 20_000,
              label: "numbered badges after the simulated missed release",
            });
            await ctx.eval(`(() => {
              const modifierKey = ${JSON.stringify(modifier.key)};
              document.addEventListener("keyup", (event) => {
                if (event.key === modifierKey) event.stopPropagation();
              }, { capture: true, once: true });
              return true;
            })()`);
            await dispatchKey(ctx, {
              type: "keyUp",
              key: modifier.key,
              code: modifier.code,
            });
            await ctx.waitFor(`${READ_VISIBLE_SHORTCUT_BADGES} >= 3`, {
              timeoutMs: 5_000,
              label: "stale badges after the app misses the release event",
            });
            await ctx.client.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: 120,
              y: 120,
              modifiers: 0,
            });
            await ctx.waitFor(`${READ_VISIBLE_SHORTCUT_BADGES} === 0`, {
              timeoutMs: 10_000,
              label: "numbered badges to clear from unmodified pointer state",
            });
            await ctx.waitFor(`${READ_VISIBLE_SHORTCUT_SLOTS} === 0`, {
              timeoutMs: 10_000,
              label: "empty shortcut slots to stop reserving sidebar width",
            });
          },
          assert: async () => {
            const visibleBadges = await ctx.eval(READ_VISIBLE_SHORTCUT_BADGES);
            ctx.assert(
              visibleBadges === 0,
              `Expected no stale shortcut badges, found ${visibleBadges}.`,
            );
            const visibleSlots = await ctx.eval(READ_VISIBLE_SHORTCUT_SLOTS);
            ctx.assert(
              visibleSlots === 0,
              `Expected hidden shortcuts to reserve no sidebar width, found ${visibleSlots} slots.`,
            );
          },
          screenshot: {
            name: "sidebar-session-number-shortcuts-missed-keyup-recovered",
            requireText: ["Shortcut proof chat"],
            hashIncludes: "/session/",
          },
        });
      },
    },
  ],
};
