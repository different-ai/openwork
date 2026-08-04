/**
 * User-facing flow demo: the composer plug menu (Skills / Extensions) paints
 * from local + cached data immediately instead of waiting for the OpenWork
 * Cloud (Den) capability fan-out.
 *
 * Perf fix under test (scratch/composer-skills-fast-load):
 * - session-surface/new-task-composer `listSkills`/`listMcp` resolve with
 *   local results + cached Connect inventory; the fresh Den fan-out lands
 *   live via a state push instead of gating the menu.
 * - the server enumerates skills from disk in parallel.
 * - first-open shows "Loading" instead of a wrong "No skills" flash.
 *
 * The final frame is the regression proof: with a signed-in scope whose Den
 * requests are artificially held for 15s (in-page fetch delay via the gateway
 * marker, so the fan-out routes through the wrappable same-origin fetch), the
 * Skills section still renders local skills in milliseconds while the cloud
 * request is provably in flight.
 *
 * Requires a workspace whose root contains `.opencode/skills` (the OpenWork
 * repo checkout at /workspace in the Daytona eval sandbox).
 */
const PLUG_BUTTON = 'button[title="Commands, skills, and MCPs"]';
const SKILL_MARKERS = ["/browser-automation", "/agent-first-screenshots"];

const DEN_KEYS_CLEANUP = `(() => {
  localStorage.removeItem("openwork.den.authToken");
  localStorage.removeItem("openwork.den.activeOrgId");
  localStorage.removeItem("openwork.den.activeOrgSlug");
  localStorage.removeItem("openwork.den.activeOrgName");
  delete window.__OPENWORK_GATEWAY__;
  return true;
})()`;

/** Close any open popover, open the plug menu, and wait for its sections. */
const openPlugMenu = async (ctx) => {
  await ctx.eval(`(() => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return true;
  })()`);
  await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(PLUG_BUTTON)}))`, {
    label: "composer plug button",
  });
  await ctx.eval(`document.querySelector(${JSON.stringify(PLUG_BUTTON)}).click()`);
  await ctx.waitFor(`(() => {
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent.trim());
    return labels.includes("Skills") && labels.includes("Extensions");
  })()`, { label: "plug menu sections" });
};

/**
 * Click the Skills section and poll (in-page, 20ms resolution) until a row
 * that only exists as a skill renders. Returns { ms, rowCount }.
 */
const SKILLS_TIMING_EXPRESSION = `new Promise((resolve) => {
  const skillsBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Skills");
  if (!skillsBtn) { resolve({ error: "skills section button not found" }); return; }
  const t0 = performance.now();
  skillsBtn.click();
  const poll = () => {
    const rows = [...document.querySelectorAll("button")].filter((b) => /^\\/[a-z0-9-]+/i.test(b.textContent.trim()));
    const hit = rows.some((b) => ${JSON.stringify(SKILL_MARKERS)}.some((marker) => b.textContent.includes(marker)));
    if (hit) { resolve({ ms: Math.round(performance.now() - t0), rowCount: rows.length }); return; }
    if (performance.now() - t0 > 20000) { resolve({ error: "timed out", bodyTail: document.body.innerText.slice(-400) }); return; }
    setTimeout(poll, 20);
  };
  poll();
})`;

export default {
  id: "composer-skills-fast-load",
  title: "Composer skills/MCP/extensions load instantly (local-first, cloud lands live)",
  kind: "user-facing",
  steps: [
    {
      name: "App boots into a workspace with a clean cloud state",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl",
        });
        await ctx.waitFor("document.body.innerText.trim().length > 40", {
          label: "rendered body text",
        });
        // Idempotence: earlier runs may have left a fake Den scope or the
        // gateway marker behind. Normalize and reload once so every frame
        // starts from the same signed-out state.
        await ctx.eval(DEN_KEYS_CLEANUP);
        await ctx.eval("location.reload()").catch(() => {});
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl after reload",
        });
        await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(PLUG_BUTTON)}))`, {
          timeoutMs: 60_000,
          label: "composer plug button",
        });
      },
    },
    {
      name: "Plug menu opens with capability sections",
      run: async (ctx) => {
        await ctx.prove("The composer plug menu lists Agents, Commands, Skills, and Extensions", {
          claim: "Clicking the plug button opens the tool menu with Agents, Commands, Skills, and Extensions sections.",
          voiceover:
            "This is the composer. The plug button opens everything the agent can use: agents, commands, skills, and extensions — one menu, four sections.",
          action: async () => {
            await openPlugMenu(ctx);
          },
          assert: async () => {
            const sections = await ctx.eval(`(() => {
              const labels = [...document.querySelectorAll("button")].map((b) => b.textContent.trim());
              return ["Agents", "Commands", "Skills", "Extensions"].filter((section) => labels.includes(section));
            })()`);
            ctx.assert(Array.isArray(sections) && sections.length === 4, `Missing sections: ${JSON.stringify(sections)}`);
          },
          screenshot: {
            name: "plug-menu-sections",
            requireText: ["Skills", "Extensions"],
          },
        });
      },
    },
    {
      name: "Skills section renders local skills instantly",
      run: async (ctx) => {
        await ctx.prove("Skills render from the local workspace in milliseconds", {
          claim: "Selecting Skills lists the workspace's local skills (with Local badges) in well under a second.",
          voiceover:
            "I open Skills. The whole list is just there — every local skill from the workspace, instantly. No spinner, no waiting on the network.",
          action: async () => {
            const timing = await ctx.eval(SKILLS_TIMING_EXPRESSION, { awaitPromise: true });
            ctx.assert(timing && !timing.error, `Skills did not render: ${JSON.stringify(timing)}`);
            ctx.log(`Skills section first paint: ${timing.ms}ms for ${timing.rowCount} rows`);
            ctx.assert(timing.rowCount >= 10, `Expected at least 10 skill rows, saw ${timing.rowCount}`);
            ctx.assert(timing.ms < 3000, `Skills took ${timing.ms}ms (expected < 3000ms)`);
          },
          assert: async () => {
            await ctx.expectText("/browser-automation");
          },
          screenshot: {
            name: "skills-section-fast",
            requireText: ["/browser-automation", "Local"],
            rejectText: ["Loading commands"],
          },
        });
      },
    },
    {
      name: "Extensions section settles with the catalog",
      run: async (ctx) => {
        await ctx.prove("Extensions settle immediately instead of hanging on a loader", {
          claim: "Selecting Extensions shows the built-in extension catalog right away.",
          voiceover:
            "Extensions behave the same way: the catalog is on screen immediately — here the built-in OpenWork Browser, already enabled.",
          action: async () => {
            await ctx.eval(`(() => {
              const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Extensions");
              btn.click();
              return true;
            })()`);
            await ctx.waitFor(`document.body.innerText.includes("OpenWork Browser")`, {
              timeoutMs: 10_000,
              label: "extensions catalog entry",
            });
          },
          assert: async () => {
            await ctx.expectText("OpenWork Browser");
          },
          screenshot: {
            name: "extensions-section",
            requireText: ["OpenWork Browser"],
            rejectText: ["Loading commands"],
          },
        });
      },
    },
    {
      name: "A fresh session composer is just as fast (cold open)",
      run: async (ctx) => {
        await ctx.prove("A brand new session's composer lists skills instantly on first open", {
          claim: "Creating a new session and opening its plug menu shows the Skills list on the very first, cold open in under 3 seconds.",
          voiceover:
            "Now a brand new session — nothing cached in this composer yet. First click on Skills: the list still lands instantly.",
          action: async () => {
            await ctx.eval(`(() => {
              document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
              const link = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => b.textContent.trim() === "New session");
              if (!link) throw new Error("New session entry not found");
              link.click();
              return true;
            })()`);
            await ctx.waitFor(`window.location.hash.includes("/session/")`, {
              timeoutMs: 30_000,
              label: "session route",
            });
            await openPlugMenu(ctx);
            const timing = await ctx.eval(SKILLS_TIMING_EXPRESSION, { awaitPromise: true });
            ctx.assert(timing && !timing.error, `Skills did not render: ${JSON.stringify(timing)}`);
            ctx.log(`Session composer cold Skills paint: ${timing.ms}ms for ${timing.rowCount} rows`);
            ctx.assert(timing.rowCount >= 10, `Expected at least 10 skill rows, saw ${timing.rowCount}`);
            ctx.assert(timing.ms < 3000, `Skills took ${timing.ms}ms (expected < 3000ms)`);
          },
          assert: async () => {
            await ctx.expectHashIncludes("/session/");
            await ctx.expectText("/browser-automation");
          },
          screenshot: {
            name: "session-composer-skills",
            requireText: ["/browser-automation"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "A hanging cloud no longer blocks the menu (regression proof)",
      run: async (ctx) => {
        await ctx.prove("Skills render in milliseconds while the Den capability fan-out hangs", {
          claim: "With a signed-in organization whose Den requests hang for 15s, the Skills section still paints local skills in under 3 seconds — the cloud fan-out is provably in flight and lands later instead of gating the menu.",
          voiceover:
            "The real test. I sign this app into an organization whose cloud is painfully slow — every capability request now hangs for fifteen seconds. Before this fix, the skills menu waited for that fan-out. Watch: the local skills still land in milliseconds, and the cloud answer merges in whenever it arrives.",
          action: async () => {
            // Cold start: reload so the composer holds no warm skills state.
            // Boot clears any locally-set Den token (the server config is the
            // source of truth), so the fake scope is installed post-boot.
            await ctx.eval("location.reload()").catch(() => {});
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "window.__openworkControl after reload",
            });
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(PLUG_BUTTON)}))`, {
              timeoutMs: 60_000,
              label: "composer plug button after reload",
            });
            const result = await ctx.eval(`new Promise((resolve) => {
              // The gateway marker routes Den API calls through the page's own
              // fetch (same-origin), which we wrap to hold capability requests
              // for 15s — a deterministic "slow cloud".
              window.__OPENWORK_GATEWAY__ = { version: 1 };
              const orig = window.fetch.bind(window);
              window.__denFetchLog = [];
              window.fetch = async (input, init) => {
                const url = typeof input === "string" ? input : (input && input.url) || String(input);
                if (String(url).includes("marketplace-capabilities")) {
                  window.__denFetchLog.push({ url: String(url).slice(0, 120), at: Math.round(performance.now()) });
                  await new Promise((r) => setTimeout(r, 15000));
                }
                return orig(input, init);
              };
              localStorage.setItem("openwork.den.authToken", "eval-slow-cloud-token");
              localStorage.setItem("openwork.den.activeOrgId", "org_slowcloud_" + Date.now());
              import("/src/react-app/domains/connections/cloud-inventory-cache.ts").then((m) => {
                const tStart = performance.now();
                const witness = { connectSettledMs: null };
                m.loadSessionConnectCapabilities().then(() => {
                  witness.connectSettledMs = Math.round(performance.now() - tStart);
                });
                document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                setTimeout(() => {
                  const plug = document.querySelector(${JSON.stringify(PLUG_BUTTON)});
                  plug.click();
                  setTimeout(() => {
                    const skillsBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Skills");
                    const t0 = performance.now();
                    skillsBtn.click();
                    const poll = () => {
                      const rows = [...document.querySelectorAll("button")].filter((b) => /^\\/[a-z0-9-]+/i.test(b.textContent.trim()));
                      const hit = rows.some((b) => ${JSON.stringify(SKILL_MARKERS)}.some((marker) => b.textContent.includes(marker)));
                      if (hit) {
                        const skillsMs = Math.round(performance.now() - t0);
                        // Give the fan-out a moment: it must STILL be pending.
                        setTimeout(() => {
                          resolve({
                            skillsMs,
                            rowCount: rows.length,
                            connectSettledMs: witness.connectSettledMs,
                            denFetchLog: window.__denFetchLog,
                          });
                        }, 1500);
                        return;
                      }
                      if (performance.now() - t0 > 20000) {
                        resolve({ error: "timed out", denFetchLog: window.__denFetchLog, bodyTail: document.body.innerText.slice(-400) });
                        return;
                      }
                      setTimeout(poll, 20);
                    };
                    poll();
                  }, 300);
                }, 100);
              }).catch((error) => resolve({ error: String(error).slice(0, 200) }));
            })`, { awaitPromise: true });
            ctx.assert(result && !result.error, `Slow-cloud scenario failed: ${JSON.stringify(result)}`);
            ctx.log(`Slow cloud: skills painted in ${result.skillsMs}ms (${result.rowCount} rows); Den fan-out requests fired: ${JSON.stringify(result.denFetchLog)}; connect settled after skills render + 1.5s: ${result.connectSettledMs === null ? "still pending (held by the 15s delay)" : `${result.connectSettledMs}ms`}`);
            ctx.assert(Array.isArray(result.denFetchLog) && result.denFetchLog.length >= 1, "The Den capability fan-out was never attempted — the slow-cloud scenario did not engage.");
            ctx.assert(result.skillsMs < 3000, `Skills took ${result.skillsMs}ms with a hanging cloud (expected < 3000ms)`);
            ctx.assert(result.connectSettledMs === null, `Connect inventory settled in ${result.connectSettledMs}ms — expected it to still be pending, so the menu provably did not wait for it.`);
            ctx.assert(result.rowCount >= 10, `Expected at least 10 skill rows, saw ${result.rowCount}`);
          },
          assert: async () => {
            await ctx.expectText("/browser-automation");
          },
          screenshot: {
            name: "skills-fast-while-cloud-hangs",
            requireText: ["/browser-automation"],
            rejectText: ["Loading commands"],
          },
        });
      },
    },
    {
      name: "Cleanup: restore the signed-out state",
      run: async (ctx) => {
        await ctx.eval(DEN_KEYS_CLEANUP);
        await ctx.eval("location.reload()").catch(() => {});
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl after cleanup",
        });
      },
    },
  ],
};
