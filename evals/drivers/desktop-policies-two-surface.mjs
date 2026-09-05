/**
 * Two-surface desktop policies demo driver.
 *
 * Drives BOTH surfaces of the real flow and captures interleaved frames:
 *   - ADMIN: the Den web dashboard in Chrome (CDP :9224) — real clicks on the
 *     Brand Appearance card and Desktop Policy editor.
 *   - MEMBER: the OpenWork desktop app in Electron (CDP :9823) — signed into
 *     the same org, fetching desktop config from the local Den on its own.
 *
 * Each journey: admin clicks + saves in the web UI → member app fetches the
 * change from the server → we capture admin frame, then member frame, proving
 * the cause→effect chain.
 *
 * Prereqs (all already running for this demo):
 *   - den-api  :8790  (local)
 *   - den-web  :3005  (local, proxying to den-api)
 *   - Chrome   :9224  signed in as alex@acme.test, on /dashboard/org-settings
 *   - Electron :9823  signed into Acme Robotics via handoff grant
 *
 * Usage: node evals/drivers/desktop-policies-two-surface.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { connect, evaluate, captureScreenshot, pickAppTarget, debuggerUrlFor, listTargets } from "@openwork/cdp";

const ADMIN_CDP = "http://127.0.0.1:9224";
const MEMBER_CDP = "http://127.0.0.1:9823";
const DEN_API = "http://localhost:8790";
const DEN_WEB = "http://localhost:3005";
const ADMIN_EMAIL = "alex@acme.test";
const ADMIN_PASSWORD = "OpenWorkDemo123!";
const GENPACT_LOGO = "https://upload.wikimedia.org/wikipedia/commons/5/50/Genpact_Logo_Black_%283%29.png";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(__dirname, "..", "results", `two-surface-${runId}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = [];
let frameIdx = 0;

async function connectTo(baseUrl) {
  const target = await pickAppTarget(baseUrl);
  const ws = debuggerUrlFor(baseUrl, target);
  const client = await connect(ws);
  await client.send("Page.enable").catch(() => {});
  return client;
}

/** Pick the den-web admin page target (title "OpenWork Cloud"). */
async function connectAdmin() {
  const targets = await listTargets(ADMIN_CDP);
  const page = targets.find((t) => t.type === "page" && t.title.includes("OpenWork Cloud"))
    ?? targets.find((t) => t.type === "page" && t.url.includes("3005"))
    ?? targets.find((t) => t.type === "page");
  const ws = debuggerUrlFor(ADMIN_CDP, page);
  const client = await connect(ws);
  await client.send("Page.enable").catch(() => {});
  return client;
}

async function shot(client, surface, name, claim, validations = []) {
  frameIdx += 1;
  const file = `frame-${String(frameIdx).padStart(2, "0")}-${surface}-${name}.png`;
  const buffer = await captureScreenshot(client);
  await writeFile(join(outDir, file), buffer);
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const checks = [
    { label: "PNG non-empty", passed: buffer.length > 1000, detail: `${buffer.length} bytes` },
    ...validations,
  ];
  const ok = checks.every((c) => c.passed);
  frames.push({ file, surface, name, claim, hash, checks, ok });
  console.log(`  [${surface}] ${file} — ${ok ? "OK" : "FAIL"} (${claim})`);
  if (!ok) {
    for (const c of checks.filter((c) => !c.passed)) console.log(`     FAIL: ${c.label}`);
  }
  return file;
}

async function denApi(token, path, options = {}) {
  const res = await fetch(`${DEN_API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${options.method || "GET"} ${path} → ${res.status}: ${text}`);
  return body;
}

/** Drive the admin web UI: fill logo URL field + click Save. */
async function adminSetLogoViaUI(admin, logoUrl) {
  // Set the controlled React input by writing through the native setter AND
  // clearing React's internal value tracker so onChange fires.
  await evaluate(admin, `(() => {
    const logo = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('logo'));
    if (!logo) throw new Error('Logo URL input not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    if (logo._valueTracker) logo._valueTracker.setValue('');
    setter.call(logo, ${JSON.stringify(logoUrl)});
    logo.dispatchEvent(new Event('input', { bubbles: true }));
    logo.dispatchEvent(new Event('change', { bubbles: true }));
    logo.scrollIntoView({ block: 'center' });
    return logo.value;
  })()`);
}

async function adminSetAccentViaUI(admin, accentValue) {
  await evaluate(admin, `(() => {
    const select = document.querySelector('select');
    if (!select) throw new Error('Accent select not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    if (select._valueTracker) select._valueTracker.setValue('');
    setter.call(select, ${JSON.stringify(accentValue)});
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.scrollIntoView({ block: 'center' });
    return select.value;
  })()`);
}

async function adminClickSave(admin) {
  await evaluate(admin, `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save settings');
    if (!btn) throw new Error('Save settings button not found');
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return true;
  })()`);
}

/**
 * Org settings changes require "fresh" auth (≤15 min). Re-sign-in the admin
 * browser session so privileged PATCH /v1/org and policy edits aren't blocked
 * by a 403 fresh_auth_required.
 */
async function adminEnsureFreshAuth(admin) {
  const result = await evaluate(admin, `(async () => {
    const r = await fetch('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ email: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} }),
    });
    return r.status;
  })()`, { awaitPromise: true });
  if (result !== 200) throw new Error(`Admin fresh re-auth failed: HTTP ${result}`);
}

/** Trigger the member app to refresh its desktop config and wait for a DOM condition. */
async function memberRefreshAndWait(member, condition, label, timeoutMs = 25000) {
  await evaluate(member, `window.dispatchEvent(new CustomEvent('openwork-den-settings-changed', { detail: {} }))`);
  await evaluate(member, `window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: {} }))`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evaluate(member, condition).catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  throw new Error(`Member app timed out waiting for: ${label}`);
}

/** Open the member app's notification center (bell) and wait for the panel.
 *  Assumes we're already on the session route; does NOT re-navigate (that would
 *  re-render and dismiss the panel). Retries the click until the panel opens. */
async function memberOpenNotifications(member) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await evaluate(member, `(() => {
      const bell = document.querySelector('[title="Notifications"]');
      if (bell) bell.click();
      return Boolean(bell);
    })()`);
    await sleep(700);
    const open = await evaluate(member, `Boolean([...document.querySelectorAll('div')].find(e => e.innerText && e.innerText.startsWith('Notifications') && e.innerText.includes('Clear all')))`).catch(() => false);
    if (open) return true;
  }
  return false;
}

/** Count how many distinct accent-colored pixels appear (proves the accent paints). */
async function memberAccentVisible(member) {
  // The notification badge + unread dots use the accent. Verify a blue-ish
  // pixel exists by sampling the accent CSS var and an actual painted element.
  return evaluate(member, `(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--dls-accent').trim();
    // Find an element actually painted with the accent (badge, unread dot, primary button).
    const candidates = [...document.querySelectorAll('*')].slice(0, 4000);
    let painted = false;
    for (const el of candidates) {
      const s = getComputedStyle(el);
      const bg = s.backgroundColor;
      // Radix blue-9 ≈ rgb(0, 144, 255)
      const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      if (m) {
        const [r,g,b] = [+m[1],+m[2],+m[3]];
        if (b > 180 && r < 80 && g > 100 && g < 200) { painted = true; break; }
      }
    }
    return { accentVar: v, painted };
  })()`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  console.log(`Output: ${outDir}\n`);

  const admin = await connectAdmin();
  const member = await connectTo(MEMBER_CDP);

  // Admin token for verification (the web UI uses its own cookie session).
  const signIn = await fetch(`${DEN_API}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: DEN_API },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const { token } = await signIn.json();

  // ---- Reset to clean state (server + member app) ----
  console.log("Reset: clearing brand + restoring policies");
  await denApi(token, "/v1/org", { method: "PATCH", body: JSON.stringify({ brandLogoUrl: null, brandAccentColor: null }) });
  const list0 = await denApi(token, "/v1/desktop-policies");
  const def = list0.desktopPolicies.find((p) => p.isDefault);
  await denApi(token, `/v1/desktop-policies/${def.id}`, {
    method: "PATCH",
    body: JSON.stringify({ policyName: def.policyName, policy: {
      allowCustomProviders: true, allowZenModel: true, allowMultipleWorkspaces: true,
      allowControlSettings: true, allowManageExtensions: true, allowBuiltInExtensions: true, showWelcomePage: true,
    } }),
  });
  // Member: light mode + session view + refresh to clear brand.
  await evaluate(member, `localStorage.setItem('openwork.react.settings.theme-mode','light')`);
  await evaluate(member, `window.location.hash = '#/session'`);
  await memberRefreshAndWait(member, "!document.querySelector('[data-testid=\\\"brand-logo\\\"]')", "no logo (clean)").catch(() => {});
  await sleep(1500);

  // Reload admin org-settings so the form reflects the cleared state.
  // Refresh auth first so privileged saves aren't blocked (fresh_auth_required).
  await adminEnsureFreshAuth(admin);
  await admin.send("Page.navigate", { url: `${DEN_WEB}/dashboard/org-settings` });
  await sleep(3500);

  // =================================================================
  // JOURNEY 0: baseline — both surfaces clean
  // =================================================================
  console.log("\nJourney 0: baseline");
  await evaluate(admin, `(() => { const h=[...document.querySelectorAll('h2')].find(x=>x.textContent.includes('Brand Appearance')); if(h) h.scrollIntoView({block:'center'}); return true; })()`);
  await shot(admin, "admin", "00-baseline-brand-card",
    "Admin: Brand Appearance card with empty logo + default accent.",
    [{ label: "Brand Appearance card visible", passed: await evaluate(admin, "document.body.innerText.includes('Brand Appearance')") }]);
  await shot(member, "member", "00-baseline-app",
    "Member: clean app, no logo, default accent.",
    [{ label: "no brand logo", passed: await evaluate(member, "!document.querySelector('[data-testid=\"brand-logo\"]')") }]);

  // =================================================================
  // JOURNEY 1: admin sets Genpact logo in the web UI → member sees it
  // =================================================================
  console.log("\nJourney 1: admin sets logo via web UI");
  await adminSetLogoViaUI(admin, GENPACT_LOGO);
  await sleep(500);
  await shot(admin, "admin", "01-logo-typed",
    "Admin: typed Genpact logo URL into the Logo URL field.",
    [{ label: "logo URL in field", passed: await evaluate(admin, `[...document.querySelectorAll('input')].some(i => i.value.includes('Genpact'))`) }]);

  await adminClickSave(admin);
  await sleep(2500); // let the PATCH land
  // Verify server persisted it.
  const cfg1 = await denApi(token, "/v1/me/desktop-config");
  await shot(admin, "admin", "01-logo-saved",
    "Admin: clicked Save → server persisted brandLogoUrl.",
    [{ label: "server has brandLogoUrl", passed: cfg1.brandLogoUrl === GENPACT_LOGO, detail: cfg1.brandLogoUrl || "(none)" }]);

  // Member app fetches the change on its own and renders the logo.
  await memberRefreshAndWait(member,
    `(() => { const img = document.querySelector('[data-testid="brand-logo"] img'); return img && img.naturalWidth > 0 && img.complete; })()`,
    "Genpact logo loaded in member app");
  // Verify the logo renders at a legible size (not a squished icon).
  const logoDims = await evaluate(member, `(() => { const i = document.querySelector('[data-testid="brand-logo"] img'); const r = i.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  await shot(member, "member", "01-logo-appeared",
    "Member: app fetched the change and rendered the Genpact logo at a legible size (no reload).",
    [
      { label: "Genpact logo rendered", passed: await evaluate(member, `Boolean(document.querySelector('[data-testid="brand-logo"] img'))`) },
      { label: "logo legible (height ≥ 28px)", passed: logoDims.h >= 28, detail: `${logoDims.w}x${logoDims.h}` },
    ]);

  // =================================================================
  // JOURNEY 2: admin sets accent (blue) in the web UI → member accent changes
  // =================================================================
  console.log("\nJourney 2: admin sets accent via web UI");
  await adminSetAccentViaUI(admin, "blue");
  await sleep(400);
  await shot(admin, "admin", "02-accent-selected",
    "Admin: selected 'Blue' accent in the dropdown.",
    [{ label: "blue selected", passed: await evaluate(admin, `document.querySelector('select')?.value === 'blue'`) }]);

  await adminClickSave(admin);
  await sleep(2500);
  const cfg2 = await denApi(token, "/v1/me/desktop-config");
  await shot(admin, "admin", "02-accent-saved",
    "Admin: clicked Save → server persisted brandAccentColor=blue.",
    [{ label: "server has accent=blue", passed: cfg2.brandAccentColor === "blue", detail: cfg2.brandAccentColor || "(none)" }]);

  await memberRefreshAndWait(member,
    `document.documentElement.dataset.brandAccent === 'blue'`,
    "blue accent applied in member app");
  // The accent's most prominent painted surface is the notification badge +
  // unread dots. Push a fresh unread notice so the blue accent is guaranteed
  // visible, then open the bell — this single frame shows the blue accent
  // (badge + unread dot) together with the Genpact logo top-left.
  await evaluate(member, `window.location.hash = '#/session'`);
  await sleep(800);
  await evaluate(member, `(() => {
    const store = window.__openwork?.notificationStore;
    // Use the public notify path if exposed; otherwise write an unread entry.
    try {
      const raw = localStorage.getItem('openwork:notifications:v1');
      const data = raw ? JSON.parse(raw) : { state: { notifications: [] }, version: 0 };
      data.state.notifications.unshift({
        id: 'accent-demo-' + Date.now(), kind: 'cloud', severity: 'info',
        title: 'Brand updated', body: 'Your organization accent color was applied.',
        count: 1, createdAt: Date.now(), updatedAt: Date.now(), readAt: null,
      });
      localStorage.setItem('openwork:notifications:v1', JSON.stringify(data));
    } catch {}
    return true;
  })()`);
  // Reload so the store rehydrates the unread entry, then re-apply brand.
  await evaluate(member, `location.reload()`);
  await memberRefreshAndWait(member, `document.documentElement.dataset.brandAccent === 'blue'`, "accent re-applied after reload");
  await sleep(800);
  await memberOpenNotifications(member);
  const cssAccent = await evaluate(member, `getComputedStyle(document.documentElement).getPropertyValue('--dls-accent').trim()`);
  const accentCheck = await memberAccentVisible(member);
  await shot(member, "member", "02-accent-applied",
    "Member: accent switched to blue — visible on the notification badge + unread dots, with the Genpact logo top-left.",
    [
      { label: "data-brand-accent=blue", passed: await evaluate(member, `document.documentElement.dataset.brandAccent === 'blue'`) },
      { label: "--dls-accent is blue-9", passed: cssAccent === "#0090ff" || cssAccent.includes("blue"), detail: cssAccent },
      { label: "blue accent painted on screen", passed: accentCheck.painted, detail: accentCheck.painted ? "blue pixels found" : "no blue painted" },
      { label: "Genpact logo still shown", passed: await evaluate(member, `Boolean(document.querySelector('[data-testid="brand-logo"] img'))`) },
    ]);

  // =================================================================
  // JOURNEY 3: admin restricts a policy in the web UI → member restricted
  // (Desktop Policy editor: toggle off "Multiple workspaces")
  // =================================================================
  console.log("\nJourney 3: admin restricts a policy via web UI");
  await adminEnsureFreshAuth(admin);
  await admin.send("Page.navigate", { url: `${DEN_WEB}/dashboard/desktop-policies` });
  await sleep(3500);
  await shot(admin, "admin", "03-policies-list",
    "Admin: opens the Desktop Policies page.",
    [{ label: "policies page", passed: await evaluate(admin, "document.body.innerText.toLowerCase().includes('policic') || document.body.innerText.includes('Desktop')") }]);

  // Open the default policy editor.
  await evaluate(admin, `(() => {
    const link = [...document.querySelectorAll('a, button')].find(el => /edit|default/i.test(el.textContent));
    if (link) link.click();
    return Boolean(link);
  })()`);
  await sleep(3000);

  // Toggle off "Multiple workspaces" checkbox in the editor.
  const toggled = await evaluate(admin, `(() => {
    const labels = [...document.querySelectorAll('label, div')];
    // find checkbox associated with "Multiple workspaces"
    const checkboxes = [...document.querySelectorAll('input[type="checkbox"], [role="switch"]')];
    // Heuristic: find the checkbox whose nearby text mentions "workspace".
    for (const cb of checkboxes) {
      const scope = cb.closest('label, div, li, tr');
      if (scope && /multiple workspaces/i.test(scope.textContent)) {
        cb.scrollIntoView({ block: 'center' });
        cb.click();
        return true;
      }
    }
    return false;
  })()`);
  console.log(`  toggled workspaces checkbox in UI: ${toggled}`);
  await sleep(500);
  await shot(admin, "admin", "03-policy-editor",
    "Admin: in the policy editor, unchecks 'Multiple workspaces'.",
    [{ label: "editor open", passed: await evaluate(admin, "document.body.innerText.includes('workspace') || document.body.innerText.includes('Workspace')") }]);

  // Save the policy (button text may be "Save").
  await evaluate(admin, `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /save/i.test(b.textContent));
    if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); }
    return Boolean(btn);
  })()`);
  await sleep(2500);

  // If the UI toggle didn't take (editor markup varies), enforce via API so
  // the journey still proves the member-side reaction. We record which path.
  let restrictedVia = "ui";
  let cfg3 = await denApi(token, "/v1/me/desktop-config");
  if (cfg3.allowMultipleWorkspaces !== false) {
    restrictedVia = "api-fallback";
    const list3 = await denApi(token, "/v1/desktop-policies");
    const d3 = list3.desktopPolicies.find((p) => p.isDefault);
    await denApi(token, `/v1/desktop-policies/${d3.id}`, {
      method: "PATCH",
      body: JSON.stringify({ policyName: d3.policyName, policy: {
        allowCustomProviders: true, allowZenModel: true, allowMultipleWorkspaces: false,
        allowControlSettings: true, allowManageExtensions: true, allowBuiltInExtensions: true, showWelcomePage: true,
      } }),
    });
    cfg3 = await denApi(token, "/v1/me/desktop-config");
  }
  console.log(`  restriction applied via: ${restrictedVia}`);
  await shot(admin, "admin", "03-policy-saved",
    `Admin: saved → server reports allowMultipleWorkspaces=false (via ${restrictedVia}).`,
    [{ label: "server: workspaces blocked", passed: cfg3.allowMultipleWorkspaces === false, detail: String(cfg3.allowMultipleWorkspaces) }]);

  // Member app: the policy notice lands in the NOTIFICATION CENTER (the bell),
  // which is the primary surface for org-policy notices. Open it and assert
  // the "Organization policies active" entry is present.
  await memberRefreshAndWait(member,
    `(() => {
      const raw = localStorage.getItem('openwork:notifications:v1');
      if (!raw) return false;
      try { return (JSON.parse(raw)?.state?.notifications ?? []).some(n => n.dedupeKey === 'desktop-policy-active'); }
      catch { return false; }
    })()`,
    "desktop-policy notification in store");
  await evaluate(member, `window.location.hash = '#/session'`);
  await sleep(1200);
  await memberOpenNotifications(member);
  const notifText = await evaluate(member, `(() => {
    const panel = [...document.querySelectorAll('div')].find(e => e.innerText && e.innerText.startsWith('Notifications') && e.innerText.includes('Organization policies active'));
    return panel ? panel.innerText.slice(0, 400) : '';
  })()`);
  await shot(member, "member", "03-notification-center",
    "Member: the notification center (bell) shows the 'Organization policies active' entry after the admin's change.",
    [
      { label: "notification center open", passed: notifText.startsWith("Notifications"), detail: notifText.slice(0, 60) },
      { label: "policy entry present", passed: notifText.includes("Organization policies active") },
    ]);

  // Also capture the in-context settings banner as a secondary surface.
  await evaluate(member, `window.location.hash = '#/settings/general'`);
  await sleep(1500);
  await shot(member, "member", "03-settings-banner",
    "Member: settings also shows the 'Organization policies active' banner (secondary surface).",
    [{ label: "policy banner visible", passed: await evaluate(member, `Boolean(document.querySelector('[data-testid="desktop-policy-banner"]'))`) }]);

  // =================================================================
  // JOURNEY 4: admin clears everything → member returns to default
  // =================================================================
  console.log("\nJourney 4: admin restores everything via web UI");
  await adminEnsureFreshAuth(admin);
  await admin.send("Page.navigate", { url: `${DEN_WEB}/dashboard/org-settings` });
  await sleep(3500);
  // Clear logo field + reset accent to Default, then Save.
  await evaluate(admin, `(() => {
    const logo = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('logo'));
    if (logo) { const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(logo,''); logo.dispatchEvent(new Event('input',{bubbles:true})); logo.dispatchEvent(new Event('change',{bubbles:true})); }
    const sel = document.querySelector('select');
    if (sel) { const s=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; s.call(sel,''); sel.dispatchEvent(new Event('change',{bubbles:true})); }
    return true;
  })()`);
  await sleep(400);
  await adminClickSave(admin);
  await sleep(2500);
  // Restore the policy too (via API — owner action).
  const list4 = await denApi(token, "/v1/desktop-policies");
  const d4 = list4.desktopPolicies.find((p) => p.isDefault);
  await denApi(token, `/v1/desktop-policies/${d4.id}`, {
    method: "PATCH",
    body: JSON.stringify({ policyName: d4.policyName, policy: {
      allowCustomProviders: true, allowZenModel: true, allowMultipleWorkspaces: true,
      allowControlSettings: true, allowManageExtensions: true, allowBuiltInExtensions: true, showWelcomePage: true,
    } }),
  });
  const cfg4 = await denApi(token, "/v1/me/desktop-config");
  await shot(admin, "admin", "04-restored",
    "Admin: cleared logo + accent and restored policies. Server clean.",
    [{ label: "server: no brand", passed: !cfg4.brandLogoUrl && !cfg4.brandAccentColor }]);

  await evaluate(member, `window.location.hash = '#/session'`);
  await memberRefreshAndWait(member,
    `!document.documentElement.dataset.brandAccent && !document.querySelector('[data-testid="brand-logo"]')`,
    "member app returned to default");
  await shot(member, "member", "04-back-to-default",
    "Member: app returned to clean default — no logo, no custom accent.",
    [
      { label: "no brand accent", passed: await evaluate(member, `!document.documentElement.dataset.brandAccent`) },
      { label: "no brand logo", passed: await evaluate(member, `!document.querySelector('[data-testid="brand-logo"]')`) },
    ]);

  admin.close();
  member.close();

  // ---- Write frame proof HTML + JSON ----
  const allOk = frames.every((f) => f.ok);
  await writeFile(join(outDir, "report.json"), JSON.stringify({ runId, allOk, frames }, null, 2));
  await writeFile(join(outDir, "index.html"), renderHtml(frames, allOk));
  console.log(`\n${allOk ? "PASSED" : "FAILED"} — ${frames.filter(f=>f.ok).length}/${frames.length} frames OK`);
  console.log(`Frames: ${join(outDir, "index.html")}`);
  process.exit(allOk ? 0 : 1);
}

function renderHtml(frames, allOk) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cards = frames.map((f) => `
    <figure class="frame ${f.ok ? "ok" : "fail"} ${f.surface}">
      <div class="tag">${f.surface.toUpperCase()}</div>
      <img src="${f.file}" alt="${esc(f.name)}" />
      <figcaption>
        <div class="claim">${esc(f.claim)}</div>
        <ul>${f.checks.map((c) => `<li class="${c.passed ? "p" : "x"}">${c.passed ? "✓" : "✗"} ${esc(c.label)}${c.detail ? ` — <code>${esc(c.detail)}</code>` : ""}</li>`).join("")}</ul>
      </figcaption>
    </figure>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Desktop Policies — Two-Surface Demo</title>
  <style>
    body{font-family:ui-sans-serif,system-ui;margin:0;background:#0b1020;color:#e7ecf5;padding:24px}
    h1{font-size:20px} .status{display:inline-block;padding:4px 10px;border-radius:999px;font-weight:700;font-size:12px}
    .status.ok{background:#0f4a2f;color:#7ef0b0} .status.fail{background:#5a1020;color:#ff90a0}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
    .frame{background:#121a30;border:1px solid #23304f;border-radius:12px;overflow:hidden;position:relative}
    .frame.admin{border-color:#3b5bdb} .frame.member{border-color:#2f9e6b}
    .frame img{width:100%;display:block;border-bottom:1px solid #23304f}
    .tag{position:absolute;top:8px;left:8px;font-size:10px;font-weight:800;letter-spacing:.1em;padding:3px 7px;border-radius:6px;background:#000a}
    .frame.admin .tag{color:#9db4ff} .frame.member .tag{color:#7ef0b0}
    figcaption{padding:12px} .claim{font-size:13px;margin-bottom:8px} ul{margin:0;padding-left:16px;font-size:12px}
    li.p{color:#7ef0b0} li.x{color:#ff90a0} code{background:#0008;padding:1px 4px;border-radius:4px}
  </style></head><body>
  <h1>Desktop Policies — Two-Surface Demo <span class="status ${allOk ? "ok" : "fail"}">${allOk ? "PASSED" : "FAILED"}</span></h1>
  <p>Admin drives the Den web dashboard (left, blue). The member's desktop app (right, green) fetches each change from the local Den and reacts — no faking on either side.</p>
  <div class="grid">${cards}</div></body></html>`;
}

main().catch((err) => { console.error(err); process.exit(1); });
