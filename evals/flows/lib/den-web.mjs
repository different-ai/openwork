/**
 * Shared den-web browser/API helpers for cloud-connection eval flows.
 */

export function denWebUrl() {
  return (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
}

export function denApiUrl() {
  return (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
}

export async function denApiFetch(path, options = {}) {
  const response = await fetch(`${denApiUrl()}${path}`, {
    ...options,
    // Better Auth rejects auth requests with no Origin header (CSRF
    // protection); a real browser always sends one, Node's fetch doesn't.
    headers: { "content-type": "application/json", origin: denWebUrl(), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}

export async function signInApi(email, password) {
  const { response, body } = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  return body.token ?? null;
}

export async function signInViaBrowser(ctx, email, password) {
  // Land on the den-web origin first so the relative sign-out fetch below
  // actually reaches den-web (a leftover session would otherwise bounce the
  // root URL straight to /dashboard with no sign-in card).
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
  await ctx.eval(`fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)`, { awaitPromise: true });
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
  await ctx.waitFor(
    "Boolean(document.querySelector('input[type=\"email\"]')) && Boolean(document.querySelector('input[type=\"password\"]'))",
    { timeoutMs: 30_000, label: "email + password fields" },
  );
  await ctx.fill('input[type="email"]', email);
  await ctx.fill('input[type="password"]', password);
  const submitted = await ctx.eval(`(() => {
    const button = document.querySelector('button[type="submit"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(submitted, "No submit button found on the sign-in card.");
  await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });
}

export async function openAdminConnections(ctx) {
  // Retry the click: on a fresh page load (especially over higher cloud
  // latency), the very first click can land before Next.js has finished
  // hydrating and attaching the link's handler. The Connections link
  // lives inside the collapsible Extensions nav group, so expand that
  // first when the link isn't in the DOM yet.
  await ctx.waitFor(
    `(() => {
      if (window.location.pathname.includes('mcp-connections')) return true;
      const link = [...document.querySelectorAll('nav a')].find((a) => a.getAttribute('href')?.includes('mcp-connections'));
      if (link) {
        link.click();
        return false;
      }
      const group = [...document.querySelectorAll('nav a, nav button')].find((el) => (el.textContent ?? '').trim().startsWith('Extensions'));
      group?.click();
      return false;
    })()`,
    { timeoutMs: 30_000, label: "MCP Connections nav link clicked" },
  );
  await ctx.waitFor("window.location.pathname.includes('mcp-connections')", {
    timeoutMs: 20_000,
    label: "MCP Connections route",
  });
}

export async function openYourConnections(ctx) {
  await ctx.waitFor(
    `(() => {
      const link = [...document.querySelectorAll('a')].find((a) => a.getAttribute('href')?.endsWith('/your-connections'));
      if (!link) return false;
      if (window.location.pathname.endsWith('/your-connections')) return true;
      link.click();
      return false;
    })()`,
    { timeoutMs: 30_000, label: "Your Connections nav" },
  );
  await ctx.waitFor("window.location.pathname.endsWith('/your-connections')", { timeoutMs: 20_000, label: "Your Connections route" });
}
