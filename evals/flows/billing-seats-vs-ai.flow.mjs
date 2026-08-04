/**
 * User-facing proof: the Billing page distinguishes Team seats from AI model
 * access instead of showing two lookalike $10 cards, and every action states
 * when to use it.
 *
 * Local runbook:
 *   1. pnpm evals --stack-down
 *   2. OPENWORK_EVAL_DEN_WEB_URL=http://127.0.0.1:3005 OPENWORK_EVAL_WEB_CDP_ADMIN=http://127.0.0.1:9855 pnpm fraimz --flow billing-seats-vs-ai --stack den
 *      (the stack exports OPENWORK_EVAL_DEN_API_URL and OPENWORK_EVAL_DEN_TOKEN)
 *   3. In another shell, run den-web against the stack API:
 *      DEN_WEB_PORT=3005 DEN_API_BASE=http://127.0.0.1:8790 DEN_AUTH_ORIGIN=http://127.0.0.1:3005 DEN_AUTH_FALLBACK_BASE=http://127.0.0.1:8790 pnpm --filter @openwork-ee/den-web dev:local
 *   4. In another shell, run Chrome for screenshots:
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9855 --user-data-dir="$(mktemp -d)" --window-size=1440,1400 about:blank
 */
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denWebUrl } from "./lib/den-web.mjs";

const FLOW_ID = "billing-seats-vs-ai";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = denWebUrl();
const ADMIN_CDP_URL = (process.env.OPENWORK_EVAL_WEB_CDP_ADMIN ?? "").trim().replace(/\/+$/, "");
const ADMIN_TOKEN = (process.env.OPENWORK_EVAL_DEN_TOKEN ?? "").trim();
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";

const state = {
  adminBrowserSignedIn: false,
  billing: null,
};

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
}

function adminAuthOrigins() {
  const origins = [];
  if (DEN_WEB_URL) origins.push(new URL(DEN_WEB_URL).origin);
  if (DEN_API_URL) {
    const apiUrl = new URL(DEN_API_URL);
    if (apiUrl.hostname === "127.0.0.1") {
      const localhostUrl = new URL(apiUrl.toString());
      localhostUrl.hostname = "localhost";
      origins.push(localhostUrl.origin);
    }
    origins.push(apiUrl.origin);
  }
  return [...new Set(origins)];
}

function sessionCookiePair(setCookie) {
  const match = String(setCookie ?? "").match(/better-auth\.session_token=([^;,\s]+)/);
  return match ? `better-auth.session_token=${match[1]}` : "";
}

async function createAdminBrowserSession(ctx) {
  let last = null;
  for (const origin of adminAuthOrigins()) {
    const response = await fetch(`${DEN_API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    const cookie = sessionCookiePair(response.headers.get("set-cookie"));
    last = { origin, status: response.status, cookie: cookie ? "<present>" : null };
    if (response.ok && typeof body?.token === "string" && cookie) {
      witness(ctx, true, "Admin API sign-in minted a den-web browser session", { origin, status: response.status });
      return { token: body.token, cookie };
    }
  }
  witness(ctx, false, "Admin API sign-in minted a den-web browser session", last);
  return null;
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;

  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) response = await fetch(`${base}/json/new?about:blank`);
  if (!response.ok) throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);

  const created = await response.json();
  if (created?.type === "page" && created.webSocketDebuggerUrl) return created;
  const targets = await listTargets(cdpBaseUrl);
  const nextPage = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!nextPage) throw new Error(`No page target available at ${cdpBaseUrl}.`);
  return nextPage;
}

async function withClient(ctx, cdpBaseUrl, fn) {
  const previous = ctx.client;
  const target = await firstPageTarget(cdpBaseUrl);
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  ctx.client = client;
  try {
    return await fn();
  } finally {
    ctx.client = previous;
    try {
      client.close();
    } catch {}
  }
}

async function goToDenWeb(ctx, path) {
  const url = path.startsWith("http") ? path : `${DEN_WEB_URL}${path}`;
  await ctx.eval(`location.assign(${JSON.stringify(url)})`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `den-web loaded ${path}` });
}

async function signInAdminBrowser(ctx) {
  if (state.adminBrowserSignedIn) return;
  const session = await createAdminBrowserSession(ctx);
  await goToDenWeb(ctx, "/");
  await ctx.eval(`(() => {
    document.cookie = 'better-auth.session_token=; Max-Age=0; Path=/';
    document.cookie = ${JSON.stringify(`${session.cookie}; Path=/; SameSite=Lax`)};
    localStorage.setItem('openwork:web:auth-token', ${JSON.stringify(session.token)});
    sessionStorage.clear();
    return true;
  })()`);
  await goToDenWeb(ctx, "/");
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "den-web dashboard after admin sign-in" });
  state.adminBrowserSignedIn = true;
}

async function openBillingPage(ctx) {
  await signInAdminBrowser(ctx);
  await goToDenWeb(ctx, "/dashboard/billing");
  await ctx.waitFor("location.pathname.includes('/dashboard/billing')", { timeoutMs: 30_000, label: "billing route" });
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"billing-summary-card\"]'))", {
    timeoutMs: 30_000,
    label: "billing summary card rendered",
  });
}

async function loadBilling(ctx) {
  const response = await fetch(`${DEN_API_URL}/v1/billing`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, origin: DEN_WEB_URL || DEN_API_URL },
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  witness(ctx, response.ok, "Admin token can load the organization billing summary", { status: response.status });
  return body?.billing?.stripe ?? null;
}

/** Reads a card's rendered text so assertions witness what the user actually sees. */
function cardTextExpression(testId) {
  return `(document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.innerText ?? '')`;
}

async function cardText(ctx, testId) {
  return ctx.eval(cardTextExpression(testId));
}

async function scrollCardIntoView(ctx, testId) {
  await ctx.eval(`(() => {
    document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await ctx.eval("new Promise((resolve) => setTimeout(resolve, 250))", { awaitPromise: true });
}

/** Money strings as the page renders them, e.g. "$40.00" -> 4000 minor units. */
function parseMoney(text) {
  const match = String(text ?? "").match(/\$([\d,]+)\.(\d{2})/);
  if (!match) return null;
  return Number.parseInt(match[1].replace(/,/g, ""), 10) * 100 + Number.parseInt(match[2], 10);
}

export default {
  id: FLOW_ID,
  title: "Billing separates Team seats from AI model access and explains every action",
  kind: "user-facing",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_WEB_CDP_ADMIN"],
  steps: [
    {
      name: "Frame 1 — One statement, two named line items, one total",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Billing opens on a single statement that lists Team seats and AI model access as separate line items and sums them into one total", {
            voiceover: vo[0],
            assert: async () => {
              state.billing = await loadBilling(ctx);
              witness(ctx, state.billing !== null, "Billing payload exposes the stripe summary", {
                configured: state.billing?.configured,
                seatsConfigured: state.billing?.seats?.configured,
                memberCount: state.billing?.memberCount,
              });

              await openBillingPage(ctx);
              const summary = await cardText(ctx, "billing-summary-card");

              witness(ctx, summary.includes("Team seats"), "The statement names the Team seats line item", summary.slice(0, 300));
              witness(ctx, summary.includes("AI model access"), "The statement names the AI model access line item", summary.slice(0, 300));
              witness(ctx, summary.includes("Total"), "The statement carries a Total row", summary.slice(0, 300));

              // The two line items must sum to the displayed total, so the page can
              // never show a charge the user cannot account for.
              const amounts = await ctx.eval(`(() => {
                const card = document.querySelector('[data-testid="billing-summary-card"]');
                if (!card) return null;
                const rows = [...card.querySelectorAll('div')].filter((el) => {
                  const text = el.innerText ?? '';
                  return /per (month|year)/.test(text) && el.children.length === 4;
                });
                return rows.map((row) => ({
                  title: (row.children[1]?.innerText ?? '').split('\\n')[0].trim(),
                  value: (row.children[2]?.innerText ?? '').split('\\n')[0].trim(),
                }));
              })()`);
              witness(ctx, Array.isArray(amounts) && amounts.length === 3, "The statement renders exactly three rows: seats, AI, and the total", amounts);

              const seatsMinor = parseMoney(amounts?.[0]?.value);
              const aiMinor = parseMoney(amounts?.[1]?.value);
              const totalMinor = parseMoney(amounts?.[2]?.value);
              witness(
                ctx,
                seatsMinor !== null && aiMinor !== null && totalMinor !== null && seatsMinor + aiMinor === totalMinor,
                "The Total equals Team seats plus AI model access",
                { seatsMinor, aiMinor, totalMinor, amounts },
              );

              ctx.output("billing-summary", JSON.stringify({
                stripeConfigured: state.billing?.configured,
                seatsConfigured: state.billing?.seats?.configured,
                memberCount: state.billing?.memberCount,
                freeSeatCount: state.billing?.seats?.freeSeatCount,
                billableSeatCount: state.billing?.seats?.billableSeatCount,
                renderedRows: amounts,
              }, null, 2));

              await scrollCardIntoView(ctx, "billing-summary-card");
            },
            screenshot: {
              name: "billing-statement",
              // "OpenWork Users" was the old seats card title; the sidebar still
              // links to OpenWork Models, so only the retired card name is rejected.
              requireText: ["Your subscriptions", "Team seats", "AI model access", "Total"],
              rejectText: ["OpenWork Users"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2 — The seats card states what seats do and do not include",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("The Team seats card explains this deployment's seat charge in plain language and never implies that seats include model access", {
            voiceover: vo[1],
            assert: async () => {
              await openBillingPage(ctx);
              const seatsCard = await cardText(ctx, "billing-seats-card");

              witness(ctx, seatsCard.startsWith("Team seats"), "The card is titled Team seats", seatsCard.slice(0, 120));

              // Whatever the deployment's Stripe state, the card must tell the user
              // that seats and model access are different purchases.
              const separatesProducts = seatsCard.includes("AI model access") || seatsCard.includes("model access");
              witness(ctx, separatesProducts, "The seats card explicitly distinguishes itself from AI model access", seatsCard.slice(0, 400));

              const seatsConfigured = state.billing?.seats?.configured === true;
              if (seatsConfigured) {
                witness(ctx, seatsCard.includes("Free seats used") || seatsCard.includes("free"), "A configured deployment shows how much of the free allowance is used", seatsCard.slice(0, 400));
              } else {
                witness(
                  ctx,
                  seatsCard.includes("not set up") && seatsCard.includes("no member limit"),
                  "An unconfigured deployment says seat billing is not set up and there is no member limit",
                  seatsCard.slice(0, 400),
                );
                witness(
                  ctx,
                  !seatsCard.includes("Add paid seats"),
                  "An unconfigured deployment never offers a seat checkout the operator cannot complete",
                  seatsCard.slice(0, 400),
                );
              }

              ctx.output("seats-card", seatsCard);
              await scrollCardIntoView(ctx, "billing-seats-card");
            },
            screenshot: {
              name: "seats-card",
              requireText: ["Team seats", "Manage members"],
              rejectText: ["OpenWork Users"],
            },
          });
        });
      },
    },
    {
      name: "Frame 3 — Every action says when to use it",
      run: async (ctx) => {
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("The AI model access card names who is billed, and every button on the page is paired with a sentence describing when to press it", {
            voiceover: vo[2],
            assert: async () => {
              await openBillingPage(ctx);
              const aiCard = await cardText(ctx, "billing-ai-card");

              witness(ctx, aiCard.startsWith("AI model access"), "The card is titled AI model access", aiCard.slice(0, 120));
              witness(
                ctx,
                aiCard.includes("Separate from seats"),
                "The AI card states that it is separate from seats",
                aiCard.slice(0, 400),
              );

              const aiConfigured = state.billing?.configured === true;
              if (aiConfigured) {
                witness(
                  ctx,
                  aiCard.includes("every active member"),
                  "A configured deployment warns that every active member is billed",
                  aiCard.slice(0, 400),
                );
              } else {
                witness(
                  ctx,
                  aiCard.includes("not set up") && aiCard.includes("own provider keys"),
                  "An unconfigured deployment says model billing is not set up and the team brings its own keys",
                  aiCard.slice(0, 400),
                );
              }

              // The regression this change guarantees: no button stands alone.
              const unexplainedActions = await ctx.eval(`(() => {
                const cards = ['billing-seats-card', 'billing-ai-card'];
                const orphans = [];
                for (const id of cards) {
                  const card = document.querySelector('[data-testid="' + id + '"]');
                  if (!card) { orphans.push({ card: id, reason: 'card missing' }); continue; }
                  for (const button of card.querySelectorAll('button')) {
                    const row = button.closest('div')?.parentElement;
                    const description = row?.querySelector('p')?.innerText?.trim() ?? '';
                    if (description.length < 20) {
                      orphans.push({ card: id, button: button.innerText.trim(), description });
                    }
                  }
                }
                return orphans;
              })()`);
              witness(
                ctx,
                Array.isArray(unexplainedActions) && unexplainedActions.length === 0,
                "Every action button in the seats and AI cards is paired with guidance text",
                unexplainedActions,
              );

              ctx.output("ai-card", aiCard);
              await scrollCardIntoView(ctx, "billing-ai-card");
            },
            screenshot: {
              name: "ai-card-actions",
              requireText: ["AI model access", "Separate from seats"],
            },
          });
        });
      },
    },
  ],
};
