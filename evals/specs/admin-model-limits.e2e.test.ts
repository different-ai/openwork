import { expect } from "vitest";
import { denFetch, evalIn, waitFor } from "@openwork/behaviors";
import { closeTarget, navigate, newPageTarget, reattachSurface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { needs, server, sleep, test, unmetNeeds } from "@openwork/testkit";
import type { DenSession, DenFetchResult } from "@openwork/behaviors";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `admin model limits skipped — needs: ${missingRequirements.join(", ")}`
  : "platform admins can manage admins and safely inspect and reset empty model consumption";

type AdminEntry = {
  id: string;
  email: string;
};

type UserEntry = {
  id: string;
  email: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsField(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter(isRecord);
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function adminsFrom(value: unknown): AdminEntry[] {
  return recordsField(value, "admins").map((entry) => ({
    id: stringField(entry, "id"),
    email: stringField(entry, "email"),
  })).filter((entry) => entry.id && entry.email);
}

function usersFrom(value: unknown): UserEntry[] {
  return recordsField(value, "users").map((entry) => ({
    id: stringField(entry, "id"),
    email: stringField(entry, "email"),
  })).filter((entry) => entry.id && entry.email);
}

function resetAmount(value: unknown): number | null {
  return isRecord(value) && typeof value.resetAmount === "number" ? value.resetAmount : null;
}

/** Bring a target into the viewport so its screenshot frame shows the claimed UI. */
async function scrollIntoView(browser: Parameters<typeof screenshot>[0], selector: string): Promise<void> {
  await evalIn(browser, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    target.scrollIntoView({ block: "center", behavior: "instant" });
    return true;
  })()`);
  await sleep(300);
}

async function adminOverview(admin: DenSession): Promise<DenFetchResult> {
  return denFetch(admin, "/v1/admin/overview", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
}

async function removeAdminByApi(admin: DenSession, adminId: string): Promise<void> {
  await denFetch(admin, `/v1/admin/admins/${encodeURIComponent(adminId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${admin.token}` },
  });
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();
  await using den = await server({
    place,
    org: {
      name: `Admin Model Limits ${stamp}`,
      admin: { name: "Admin Limits Eval" },
      members: { jordan: { name: "Jordan Limits Eval" } },
    },
  });
  const member = den.members.jordan;
  if (!member) throw new Error("server() did not provision the jordan member session");

  const initialOverview = await adminOverview(den.admin);
  expect(initialOverview.response.ok, initialOverview.text.slice(0, 500)).toBe(true);
  const initialAdmins = adminsFrom(initialOverview.body);
  const memberUser = usersFrom(initialOverview.body).find((user) => user.email === member.email);
  expect(memberUser, `Admin overview did not contain ${member.email}`).toBeDefined();
  if (!memberUser) throw new Error(`Admin overview did not contain ${member.email}`);

  await using browser = await chrome({
    name: "admin-model-limits",
    startUrl: `${den.ref.webUrl}/admin`,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const initialTargetId = browser.client.targetId;
  await newPageTarget(browser.handle.cdpUrl, `${den.ref.webUrl}/admin`, { timeoutMs: 60_000 });
  if (initialTargetId) await closeTarget(browser.handle.cdpUrl, initialTargetId);
  await reattachSurface(browser, { timeoutMs: 60_000 });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 180_000,
    label: "Den Web origin before admin authentication",
  });

  const rawSignIn = await evalIn(browser, `(async () => {
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email: ${JSON.stringify(den.admin.email)},
        password: ${JSON.stringify(den.admin.password)}
      })
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  const signInOk = isRecord(rawSignIn) && rawSignIn.ok === true;
  expect(signInOk, `Browser sign-in failed: ${JSON.stringify(rawSignIn)}`).toBe(true);

  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(tokenStored).toBe(true);
  await navigate(browser.client, `${den.ref.webUrl}/admin`);
  await waitFor(browser, `document.body.innerText.includes("Platform admins")
    && Boolean(document.querySelector('[data-testid="admin-add-email"]'))
    && Boolean(document.querySelector('[data-testid="admin-add-note"]'))
    && Boolean(document.querySelector('[data-testid="admin-add-action"]'))`, {
    timeoutMs: 60_000,
    label: "admin panel platform admin controls",
  });

  const controlsVisible = await evalIn(browser, `(() => {
    const body = document.body.innerText;
    return body.includes("Platform admins")
      && Boolean(document.querySelector('[data-testid="admin-add-email"]'))
      && Boolean(document.querySelector('[data-testid="admin-add-note"]'))
      && Boolean(document.querySelector('[data-testid="admin-add-action"]'))
      && !body.includes("You do not have access")
      && !body.includes("Backoffice request failed");
  })()`);
  expect(controlsVisible).toBe(true);
  evidence.recordAssertionEvidence(
    "The authenticated /admin panel exposes Platform admins controls without an access or load failure",
    `controlsVisible=${String(controlsVisible)}`,
    controlsVisible === true,
  );

  await scrollIntoView(browser, '[data-testid="admin-add-email"]');
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "A Platform admins section is visible with an email field, a note field, and an Add admin button",
      "A user backoffice page is shown with user rows listing email addresses",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const selected = await evalIn(browser, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-testid="admin-user-row-${memberUser.id}"]`)});
    const button = row?.querySelector("button");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  expect(selected).toBe(true);
  await waitFor(browser, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-testid="admin-user-row-${memberUser.id}"]`)});
    const section = row?.querySelector('[data-testid="admin-usage-section"]');
    const reset = section?.querySelector('[data-testid="admin-usage-reset-open"]');
    return Boolean(section)
      && (section?.textContent ?? "").includes("OpenWork model consumption")
      && (section?.textContent ?? "").includes("No organization consumption windows are available for this user.")
      && reset?.disabled === true;
  })()`, {
    timeoutMs: 30_000,
    label: "expanded member empty model consumption state",
  });
  const emptyUsageState = await evalIn(browser, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-testid="admin-user-row-${memberUser.id}"]`)});
    const section = row?.querySelector('[data-testid="admin-usage-section"]');
    const text = section?.textContent ?? "";
    const reset = section?.querySelector('[data-testid="admin-usage-reset-open"]');
    return {
      heading: text.includes("OpenWork model consumption"),
      empty: text.includes("No organization consumption windows are available for this user."),
      resetDisabled: reset?.disabled === true,
      hasWindowUsage: text.includes("Shared:") || text.includes("No current five-hour, weekly, or monthly windows.")
    };
  })()`);
  const emptyUsageProved = isRecord(emptyUsageState)
    && emptyUsageState.heading === true
    && emptyUsageState.empty === true
    && emptyUsageState.resetDisabled === true
    && emptyUsageState.hasWindowUsage === false;
  expect(emptyUsageProved, JSON.stringify(emptyUsageState)).toBe(true);
  evidence.recordAssertionEvidence(
    "An expanded user shows OpenWork model consumption's explicit empty state, no window usage, and a disabled reset",
    JSON.stringify(emptyUsageState),
    emptyUsageProved,
  );

  await scrollIntoView(browser, `[data-testid="admin-user-row-${memberUser.id}"] [data-testid="admin-usage-section"]`);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "An expanded user row shows a section headed OpenWork model consumption",
      "That section says no organization consumption windows are available for this user",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const addedEmail = `added-admin-${stamp}@openwork.test`;
  const addedNote = `Admin model limits eval ${stamp}`;
  let addedAdminId = "";
  try {
    const recorderInstalled = await evalIn(browser, `(() => {
      const calls = [];
      window.__adminAdminsCalls = calls;
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
        if (!url.includes("/v1/admin/admins")) return original(input, init);
        try {
          const response = await original(input, init);
          const text = await response.clone().text().catch(() => "");
          calls.push({ url, method, status: response.status, ok: response.ok, text: text.slice(0, 500) });
          return response;
        } catch (error) {
          calls.push({ url, method, error: String(error) });
          throw error;
        }
      };
      return Array.isArray(window.__adminAdminsCalls);
    })()`);
    expect(recorderInstalled).toBe(true);
    const formFilled = await evalIn(browser, `(() => {
      const email = document.querySelector('[data-testid="admin-add-email"]');
      const note = document.querySelector('[data-testid="admin-add-note"]');
      if (!email || !note) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(email, ${JSON.stringify(addedEmail)});
      email.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(note, ${JSON.stringify(addedNote)});
      note.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    expect(formFilled).toBe(true);
    await waitFor(browser, `document.querySelector('[data-testid="admin-add-action"]')?.disabled === false`, {
      timeoutMs: 10_000,
      label: "Add admin action enabled after filling stable fields",
    });
    const formSubmitted = await evalIn(browser, `(() => {
      const action = document.querySelector('[data-testid="admin-add-action"]');
      if (!action || action.disabled) return false;
      action.click();
      return true;
    })()`);
    expect(formSubmitted).toBe(true);
    await waitFor(browser, `Array.isArray(window.__adminAdminsCalls) && window.__adminAdminsCalls.some((call) => call.method === "POST")`, {
      timeoutMs: 30_000,
      label: "Add admin POST settled in the browser",
    });
    const addCall = await evalIn(browser, `window.__adminAdminsCalls.find((call) => call.method === "POST")`);
    const addCallOk = isRecord(addCall) && addCall.ok === true;
    expect(addCallOk, `Add admin POST did not succeed: ${JSON.stringify(addCall)}`).toBe(true);
    await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(addedEmail)})`, {
      timeoutMs: 30_000,
      label: "new platform admin visible after Add admin",
    });

    const addedOverview = await adminOverview(den.admin);
    expect(addedOverview.response.ok, addedOverview.text.slice(0, 500)).toBe(true);
    const addedAdmins = adminsFrom(addedOverview.body);
    const addedAdmin = addedAdmins.find((admin) => admin.email === addedEmail);
    expect(addedAdmin, `Overview admins ${JSON.stringify(addedAdmins)} did not contain added admin ${addedEmail}`).toBeDefined();
    if (!addedAdmin) throw new Error(`Overview did not contain added admin ${addedEmail}`);
    addedAdminId = addedAdmin.id;
    const addedRowVisible = await evalIn(browser, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="admin-remove-${addedAdmin.id}"]`)}))`);
    expect(addedRowVisible, `Added admin ${addedAdmin.id} has no remove control in the UI`).toBe(true);
    const uiHasAddedAdmin = await evalIn(browser, `document.body.innerText.includes(${JSON.stringify(addedEmail)})`);
    const initiallyAbsent = !initialAdmins.some((admin) => admin.email === addedEmail);
    expect(uiHasAddedAdmin).toBe(true);
    expect(initiallyAbsent).toBe(true);
    evidence.recordAssertionEvidence(
      "Add admin creates a previously absent platform admin in the UI and live overview API",
      `email=${addedEmail}; ui=${String(uiHasAddedAdmin)}; api=${addedAdmins.some((admin) => admin.email === addedEmail)}; initiallyAbsent=${initiallyAbsent}`,
      uiHasAddedAdmin === true && addedAdmins.some((admin) => admin.email === addedEmail) && initiallyAbsent,
    );

    await scrollIntoView(browser, `[data-testid="admin-remove-${addedAdmin.id}"]`);
    {
      const shot = await screenshot(browser);
      const seen = await validate(shot, [
        "The Platform admins section lists an admin entry whose email begins with added-admin-",
        "A Remove button is visible next to that newly added admin entry",
      ]);
      expect(seen.ok, seen.why).toBe(true);
    }

    const removeClicked = await evalIn(browser, `(() => {
      const button = document.querySelector(${JSON.stringify(`[data-testid="admin-remove-${addedAdmin.id}"]`)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    expect(removeClicked).toBe(true);
    await waitFor(browser, `Array.isArray(window.__adminAdminsCalls) && window.__adminAdminsCalls.some((call) => call.method === "DELETE")`, {
      timeoutMs: 30_000,
      label: "Remove admin DELETE settled in the browser",
    });
    const removeCall = await evalIn(browser, `window.__adminAdminsCalls.find((call) => call.method === "DELETE")`);
    const removeCallOk = isRecord(removeCall) && removeCall.ok === true;
    expect(removeCallOk, `Remove admin DELETE did not succeed: ${JSON.stringify(removeCall)}`).toBe(true);
    await waitFor(browser, `!document.body.innerText.includes(${JSON.stringify(addedEmail)})`, {
      timeoutMs: 30_000,
      label: "removed platform admin absent from UI",
    });
    const removedOverview = await adminOverview(den.admin);
    expect(removedOverview.response.ok, removedOverview.text.slice(0, 500)).toBe(true);
    const removedAdmins = adminsFrom(removedOverview.body);
    const uiStillHasRemovedAdmin = await evalIn(browser, `document.body.innerText.includes(${JSON.stringify(addedEmail)})`);
    const apiStillHasRemovedAdmin = removedAdmins.some((admin) => admin.email === addedEmail);
    expect(uiStillHasRemovedAdmin).toBe(false);
    expect(apiStillHasRemovedAdmin).toBe(false);
    evidence.recordAssertionEvidence(
      "Remove admin makes the added platform admin absent from both the UI and live overview API",
      `email=${addedEmail}; uiStillPresent=${String(uiStillHasRemovedAdmin)}; apiStillPresent=${apiStillHasRemovedAdmin}`,
      uiStillHasRemovedAdmin === false && !apiStillHasRemovedAdmin,
    );
    addedAdminId = "";

    const usage = await denFetch(den.admin, `/v1/admin/users/${encodeURIComponent(memberUser.id)}/inference-usage`, {
      headers: { authorization: `Bearer ${den.admin.token}` },
    });
    const usageOrganizations = recordsField(usage.body, "organizations");
    expect(usage.response.ok, usage.text.slice(0, 500)).toBe(true);
    expect(isRecord(usage.body) && Array.isArray(usage.body.organizations)).toBe(true);

    const firstReset = await denFetch(den.admin, `/v1/admin/users/${encodeURIComponent(memberUser.id)}/inference-usage/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${den.admin.token}` },
      body: JSON.stringify({}),
    });
    const secondReset = await denFetch(den.admin, `/v1/admin/users/${encodeURIComponent(memberUser.id)}/inference-usage/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${den.admin.token}` },
      body: JSON.stringify({}),
    });
    expect(firstReset.response.ok, firstReset.text.slice(0, 500)).toBe(true);
    expect(secondReset.response.ok, secondReset.text.slice(0, 500)).toBe(true);
    expect(resetAmount(firstReset.body)).toBe(0);
    expect(resetAmount(secondReset.body)).toBe(0);
    evidence.recordAssertionEvidence(
      "Live member consumption APIs return an organizations array and repeated empty resets safely forgive zero units",
      `organizations=${usageOrganizations.length}; firstReset=${resetAmount(firstReset.body)}; secondReset=${resetAmount(secondReset.body)}`,
      usage.response.ok
        && isRecord(usage.body)
        && Array.isArray(usage.body.organizations)
        && firstReset.response.ok
        && secondReset.response.ok
        && resetAmount(firstReset.body) === 0
        && resetAmount(secondReset.body) === 0,
    );
  } finally {
    const cleanupOverview = await adminOverview(den.admin).catch(() => null);
    const cleanupAdmin = cleanupOverview?.response.ok
      ? adminsFrom(cleanupOverview.body).find((admin) => admin.email === addedEmail)
      : undefined;
    const cleanupAdminId = cleanupAdmin?.id ?? addedAdminId;
    if (cleanupAdminId) {
      await removeAdminByApi(den.admin, cleanupAdminId).catch(() => undefined);
    }
  }
});
