import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "client-connect-link";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "")
  .trim()
  .replace(/\/+$/, "");
const DEN_TOKEN = (process.env.OPENWORK_EVAL_DEN_TOKEN ?? "").trim();
const PRIVATE_KEY_PEM = process.env.DEN_CONNECT_LINK_PRIVATE_KEY ?? "";
const KEY_ID = (process.env.DEN_CONNECT_LINK_KEY_ID ?? "").trim();
const BOOTSTRAP_PATH = (
  process.env.OPENWORK_EVAL_CONNECT_BOOTSTRAP_PATH ?? ""
).trim();
const TEST_ICON_URL =
  "https://upload.wikimedia.org/wikipedia/commons/6/6a/JavaScript-logo.png";
const RECIPIENT = `maya.connect+${Date.now().toString(36)}@acme.test`;

const state = {
  appUrl: null,
  connectUrl: null,
  initialBuildInfo: null,
  persistedBootstrap: null,
};

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual:
      actual === undefined ? undefined : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion);
}

async function denFetch(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("origin", DEN_API_URL);
  if (options.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (DEN_TOKEN) headers.set("authorization", `Bearer ${DEN_TOKEN}`);
  const response = await fetch(`${DEN_API_URL}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // The dev email endpoint intentionally returns rendered HTML.
  }
  return { response, body, text };
}

async function navigateTo(ctx, url) {
  if (url.startsWith("file://")) {
    await ctx.client.send("Page.navigate", { url });
  } else {
    await ctx.eval(`location.assign(${JSON.stringify(url)}); true`);
  }
  await ctx.waitFor("document.readyState === 'complete'", {
    timeoutMs: 30_000,
    label: `load ${url}`,
  });
}

function bootstrapText() {
  return existsSync(BOOTSTRAP_PATH)
    ? readFileSync(BOOTSTRAP_PATH, "utf8")
    : null;
}

function tokenFromConnectUrl() {
  return new URL(state.connectUrl).searchParams.get("token") ?? "";
}

function decodeClaims(token) {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function expiredConnectUrl() {
  const now = Math.floor(Date.now() / 1000);
  const claims = decodeClaims(tokenFromConnectUrl());
  const expiredClaims = {
    ...claims,
    iat: now - 7_200,
    exp: now - 3_600,
    jti: randomBytes(16).toString("base64url"),
  };
  const header = { alg: "EdDSA", typ: "JWT", kid: KEY_ID };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(expiredClaims)).toString("base64url")}`;
  const signature = sign(
    null,
    Buffer.from(signingInput),
    createPrivateKey(PRIVATE_KEY_PEM),
  ).toString("base64url");
  return `openwork://connect?token=${encodeURIComponent(`${signingInput}.${signature}`)}`;
}

function tamperedConnectUrl() {
  const url = new URL(state.connectUrl);
  const token = url.searchParams.get("token") ?? "";
  const parts = token.split(".");
  const payload = parts[1] ?? "";
  const index = Math.max(1, Math.floor(payload.length / 2));
  const replacement = payload[index] === "A" ? "B" : "A";
  parts[1] = `${payload.slice(0, index)}${replacement}${payload.slice(index + 1)}`;
  url.searchParams.set("token", parts.join("."));
  return url.toString();
}

async function dispatchDeepLink(ctx, rawUrl) {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(rawUrl)};
    window.__OPENWORK__ ??= {};
    window.__OPENWORK__.deepLinks = [...(window.__OPENWORK__.deepLinks ?? []), url];
    window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url] } }));
    return true;
  })()`);
}

async function dismissConnectDialog(ctx) {
  await ctx.trustedClick('[data-testid="connect-error-dismiss"]');
  await ctx.waitFor(
    '!document.querySelector("[data-testid=connect-confirm-dialog]")',
    {
      label: "connect error dialog to close",
    },
  );
}

export default {
  id: FLOW_ID,
  title:
    "A network-neutral enterprise install becomes the organization's branded app",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_CONNECT_BOOTSTRAP_PATH",
    "DEN_CONNECT_LINK_PRIVATE_KEY",
    "DEN_CONNECT_LINK_KEY_ID",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove(
          "OpenWork Enterprise starts network-neutral and ready to connect",
          {
            voiceover: vo[0],
            action: async () => {
              state.appUrl = await ctx.eval("location.href");
              await ctx.waitFor(
                'Boolean(document.querySelector("[data-testid=ready-to-connect-page]"))',
                {
                  timeoutMs: 45_000,
                  label: "ready-to-connect client page",
                },
              );
              state.initialBuildInfo = await ctx.eval(
                'window.__OPENWORK_ELECTRON__.invokeDesktop("appBuildInfo")',
                { awaitPromise: true },
              );
            },
            assert: async () => {
              await ctx.expectText("OPENWORK ENTERPRISE");
              await ctx.expectText("Ready to connect");
              await ctx.expectText("will not connect to OpenWork Cloud automatically");
              witness(
                ctx,
                bootstrapText() === null,
                "The fresh client has no desktop bootstrap configuration",
                BOOTSTRAP_PATH,
              );
              witness(
                ctx,
                state.initialBuildInfo?.enterprise === true &&
                  state.initialBuildInfo?.enterpriseNetworkLocked === true,
                "The enterprise shell reports vendor-cloud networking locked before configuration",
                state.initialBuildInfo,
              );
            },
            screenshot: {
              name: "client-ready-to-connect",
              requireText: [
                "OPENWORK ENTERPRISE",
                "Ready to connect",
                "will not connect to OpenWork Cloud automatically",
              ],
              rejectText: ["Folders", "Engines"],
            },
          },
        );
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove(
          "Acme's admin mints a signed link and the real connect email reaches the dev outbox",
          {
            voiceover: vo[1],
            action: async () => {
              const org = await denFetch("/v1/org");
              witness(
                ctx,
                org.response.ok,
                "The seeded admin can load the Acme organization",
                org.response.status,
              );
              const branded = await denFetch("/v1/org", {
                method: "PATCH",
                body: JSON.stringify({
                  name: "Acme Robotics",
                  brandAppName: "Acme Work",
                  brandIconUrl: TEST_ICON_URL,
                }),
              });
              witness(
                ctx,
                branded.response.ok &&
                  branded.body?.organization?.name === "Acme Robotics",
                "The reusable eval organization uses Acme's approved name and app brand",
                {
                  status: branded.response.status,
                  name: branded.body?.organization?.name,
                  brandAppName: branded.body?.organization?.metadata?.brandAppName,
                  brandIconUrl: branded.body?.organization?.metadata?.brandIconUrl,
                },
              );
              const organizationId = org.body?.organization?.id;
              witness(
                ctx,
                typeof organizationId === "string",
                "Acme exposes an organization id",
                organizationId,
              );

              const minted = await denFetch(
                `/v1/orgs/${organizationId}/connect-links`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    email: RECIPIENT,
                    ttlHours: 72,
                    send: true,
                  }),
                },
              );
              witness(
                ctx,
                minted.response.ok,
                "The admin connect-link route accepts the request",
                {
                  status: minted.response.status,
                  emailed: minted.body?.emailed,
                  recipient: minted.body?.recipient,
                },
              );
              witness(
                ctx,
                minted.body?.emailed === true &&
                  minted.body?.recipient === RECIPIENT,
                "Den reports that the connect email was sent",
                minted.body,
              );
              state.connectUrl = minted.body?.connectUrl ?? null;
              witness(
                ctx,
                typeof state.connectUrl === "string" &&
                  state.connectUrl.startsWith("openwork://connect?token="),
                "Den returns one opaque signed connect envelope",
                "openwork://connect?token=[redacted]",
              );

              const outbox = await denFetch(
                "/v1/dev/emails?template=connectDesktop",
              );
              const emails = Array.isArray(outbox.body?.emails)
                ? outbox.body.emails
                : [];
              witness(
                ctx,
                outbox.response.ok && emails[0]?.to === RECIPIENT,
                "The dev outbox contains Maya's connect email",
                emails[0],
              );
              ctx.output(
                "connect-email",
                JSON.stringify(
                  {
                    to: RECIPIENT,
                    subject: emails[0]?.subject,
                    connectUrl: "openwork://connect?token=[redacted]",
                  },
                  null,
                  2,
                ),
              );

              await navigateTo(
                ctx,
                `${DEN_API_URL}/v1/dev/emails/last?template=connectDesktop`,
              );
              await ctx.waitForText("Connect your desktop to Acme Robotics");
              await ctx.eval(`(() => {
                for (const link of document.querySelectorAll('a[href^="openwork://connect"]')) {
                  link.setAttribute("href", "openwork://connect?token=[redacted]");
                }
                return true;
              })()`);
            },
            assert: async () => {
              await ctx.expectText("Connect your desktop");
              await ctx.expectText("Connect your desktop to Acme Robotics");
              await ctx.expectText("it never signs you in");
            },
            screenshot: {
              name: "connect-desktop-email",
              requireText: [
                "Connect your desktop to Acme Robotics",
                "Connect your desktop",
                "it never signs you in",
              ],
            },
          },
        );
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove(
          "The client sends the opaque link to Electron for offline signature verification",
          {
            voiceover: vo[2],
            action: async () => {
              await navigateTo(ctx, state.appUrl);
              await ctx.waitFor("Boolean(window.__openworkControl)", {
                timeoutMs: 30_000,
                label: "OpenWork app after email",
              });
              const verified = await ctx.eval(
                `window.__OPENWORK_ELECTRON__.invokeDesktop("connectLinkVerify", ${JSON.stringify(state.connectUrl)})`,
                { awaitPromise: true },
              );
              witness(
                ctx,
                verified?.ok === true &&
                  verified.claims?.org?.name === "Acme Robotics" &&
                  verified.claims?.brand?.appName === "Acme Work" &&
                  verified.claims?.brand?.iconUrl === TEST_ICON_URL &&
                  verified.kid === KEY_ID,
                "Electron accepts the signature with the public key embedded for this key id",
                verified?.ok
                  ? {
                      ok: true,
                      kid: verified.kid,
                      org: verified.claims.org.name,
                      appName: verified.claims.brand.appName,
                      iconUrl: verified.claims.brand.iconUrl,
                      audience: verified.claims.aud,
                    }
                  : verified,
              );
              ctx.output(
                "offline-signature-verification",
                JSON.stringify(
                  {
                    ok: true,
                    kid: verified.kid,
                    organization: verified.claims.org.name,
                    appName: verified.claims.brand.appName,
                    iconUrl: verified.claims.brand.iconUrl,
                    token: "[redacted]",
                  },
                  null,
                  2,
                ),
              );
              await ctx.fill(
                '[data-testid="connect-link-paste-input"]',
                state.connectUrl,
              );
              await new Promise((resolve) => setTimeout(resolve, 100));
              await ctx.eval(
                'document.querySelector("[data-testid=connect-link-paste-submit]").click()',
              );
              await ctx.waitForText("Set up Acme Work for Acme Robotics?", {
                timeoutMs: 30_000,
              });
              await new Promise((resolve) => setTimeout(resolve, 250));
              // Electron's compositor can return a partially black first
              // capture after this modal transition. Prime it once so the
              // evidence capture below reflects the fully painted dialog.
              await ctx.client.send("Page.captureScreenshot", {
                format: "png",
              });
            },
            assert: async () => {
              await ctx.expectText("Set up Acme Work for Acme Robotics?");
              await ctx.expectNoText("This link can't be used");
              witness(
                ctx,
                bootstrapText() === null,
                "Verification alone does not write the desktop bootstrap",
                BOOTSTRAP_PATH,
              );
            },
            screenshot: {
              name: "connect-link-signature-verified",
              requireText: [
                "Set up Acme Work for Acme Robotics?",
                "localhost",
                "The link only configures the app",
              ],
            },
          },
        );
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove(
          "The confirmation names Acme and its exact server before any write",
          {
            voiceover: vo[3],
            action: async () => {
              const point = await ctx.waitFor(`(() => {
                const target = document.querySelector('[data-testid="connect-confirm-dialog"] .rounded-md .font-medium');
                if (!target) return null;
                const rect = target.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              })()`, {
                label: "server value in confirmation dialog",
              });
              await ctx.client.send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: point.x,
                y: point.y,
              });
              await ctx.client.send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x: point.x,
                y: point.y,
                button: "left",
                clickCount: 2,
              });
              await ctx.client.send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x: point.x,
                y: point.y,
                button: "left",
                clickCount: 2,
              });
            },
            assert: async () => {
              await ctx.expectText("Set up Acme Work for Acme Robotics?");
              await ctx.expectText("localhost");
              await ctx.expectText("Nothing has been changed yet.");
              witness(
                ctx,
                bootstrapText() === null,
                "The signed target remains unapplied until Maya confirms",
                BOOTSTRAP_PATH,
              );
            },
            screenshot: {
              name: "connect-link-confirmation",
              requireText: [
                "Set up Acme Work for Acme Robotics?",
                "localhost",
                "Nothing has been changed yet.",
                "The link only configures the app",
              ],
            },
          },
        );
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove(
          "One confirmation persists Acme's server and hands control to SSO",
          {
            voiceover: vo[4],
            action: async () => {
              await ctx.trustedClick('[data-testid="connect-confirm-accept"]');
              await ctx.waitFor(
                '!document.querySelector("[data-testid=ready-to-connect-page]")',
                {
                  timeoutMs: 30_000,
                  label: "ready-to-connect gate to release",
                },
              );
              await ctx.waitForText("Sign in", { timeoutMs: 30_000 });
            },
            assert: async () => {
              const persisted = bootstrapText();
              witness(
                ctx,
                persisted !== null,
                "Confirmation writes desktop-bootstrap.json",
                BOOTSTRAP_PATH,
              );
              const bootstrap = JSON.parse(persisted);
              witness(
                ctx,
                bootstrap.requireSignin === true &&
                  bootstrap.brandAppName === "Acme Work" &&
                  bootstrap.brandIconUrl === TEST_ICON_URL,
                "The persisted JSON keeps SSO required and applies Acme's managed name and icon",
                bootstrap,
              );
              witness(
                ctx,
                bootstrap.configured === undefined,
                "The derived configured flag is never persisted",
                bootstrap,
              );
              state.persistedBootstrap = persisted;
              const iconState = await ctx.eval(
                "window.__OPENWORK_ELECTRON__?.brandIcon?.getState?.()",
                { awaitPromise: true },
              );
              witness(
                ctx,
                iconState?.applied === true &&
                  iconState?.sourceUrl === TEST_ICON_URL,
                "The packaged macOS app applies the signed HTTPS native icon immediately",
                iconState,
              );
              const buildInfo = await ctx.eval(
                'window.__OPENWORK_ELECTRON__.invokeDesktop("appBuildInfo")',
                { awaitPromise: true },
              );
              witness(
                ctx,
                buildInfo?.enterprise === true &&
                  buildInfo?.enterpriseNetworkLocked === false,
                "A confirmed organization config unlocks the enterprise network boundary",
                buildInfo,
              );
              await ctx.expectText("Acme Work");
              await ctx.expectText("Sign in");
            },
            screenshot: {
              name: "acme-sso-after-connect",
              requireText: ["Acme Work", "Sign in"],
              rejectText: ["Ready to connect"],
            },
          },
        );
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove(
          "Tampered and expired links are refused without changing Acme's configuration",
          {
            voiceover: vo[5],
            action: async () => {
              await dispatchDeepLink(ctx, tamperedConnectUrl());
              await ctx.waitForText("failed verification", {
                timeoutMs: 30_000,
              });
              witness(
                ctx,
                bootstrapText() === state.persistedBootstrap,
                "A tampered token leaves the existing bootstrap untouched",
                "unchanged",
              );
              await dismissConnectDialog(ctx);

              await dispatchDeepLink(ctx, expiredConnectUrl());
              await ctx.waitForText("link has expired", { timeoutMs: 30_000 });
            },
            assert: async () => {
              await ctx.expectText("This link can't be used");
              await ctx.expectText("link has expired");
              await ctx.expectText("Nothing about this app was changed.");
              witness(
                ctx,
                bootstrapText() === state.persistedBootstrap,
                "An expired token leaves the existing bootstrap untouched",
                "unchanged",
              );
            },
            screenshot: {
              name: "expired-connect-link-refused",
              requireText: [
                "This link can't be used",
                "link has expired",
                "Nothing about this app was changed.",
              ],
            },
          },
        );
      },
    },
  ],
};
