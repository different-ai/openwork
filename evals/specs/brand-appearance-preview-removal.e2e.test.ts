import { expect } from "vitest";
import { denFetch, evalIn, fill, signInInBrowser, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Brand appearance preview removal skipped — needs: ${missingRequirements.join(", ")}`
  : "Brand appearance keeps editable desktop identity controls without a Preview card";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function organizationId(session: DenSession): Promise<string> {
  const response = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
  });
  const organizations = isRecord(response.body) && Array.isArray(response.body.orgs)
    ? response.body.orgs.filter(isRecord)
    : [];
  const id = organizations[0] && typeof organizations[0].id === "string"
    ? organizations[0].id
    : "";
  if (!response.response.ok || !id) {
    throw new Error(`Resolving the test organization failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
  return id;
}

async function setBranding(
  session: DenSession,
  orgId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const response = await denFetch(session, "/v1/org", {
    method: "PATCH",
    headers: {
      ...auth(session),
      "content-type": "application/json",
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify(input),
  });
  if (!response.response.ok) {
    throw new Error(`Saving test branding failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
}

async function organizationMetadata(session: DenSession, orgId: string): Promise<Record<string, unknown>> {
  const response = await denFetch(session, "/v1/org", {
    headers: {
      ...auth(session),
      "x-openwork-org-id": orgId,
    },
  });
  const organization = isRecord(response.body) && isRecord(response.body.organization)
    ? response.body.organization
    : null;
  const rawMetadata = organization?.metadata;
  if (!response.response.ok || (typeof rawMetadata !== "string" && !isRecord(rawMetadata))) {
    throw new Error(`Reading saved branding failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
  if (isRecord(rawMetadata)) return rawMetadata;
  const parsed = JSON.parse(rawMetadata) as unknown;
  if (!isRecord(parsed)) throw new Error("The organization metadata was not an object.");
  return parsed;
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();
  const initialName = `Existing desktop brand ${stamp}`;
  const updatedName = `Updated desktop brand ${stamp}`;
  const existingLogoUrl = "https://assets.example.test/existing-wordmark.png";

  await using den = await server({
    place,
    org: {
      name: `Brand appearance ${stamp}`,
      admin: { name: "Brand Appearance Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  await setBranding(den.admin, orgId, {
    brandAppName: initialName,
    brandAccentColor: "violet",
    brandLogoUrl: existingLogoUrl,
  });

  await using browser = await chrome({
    name: "brand-appearance-preview-removal",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 820,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before admin sign-in",
  });
  await signInInBrowser(browser, den.ref.webUrl, den.admin);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/brand-appearance`);
  await waitFor(browser, `(() => {
    const input = document.querySelector('input[placeholder="OpenWork"]');
    const select = document.querySelector('[data-testid="brand-identity-fields"] select');
    return document.body.innerText.includes("Desktop identity")
      && input instanceof HTMLInputElement
      && input.value === ${JSON.stringify(initialName)}
      && select instanceof HTMLSelectElement
      && select.value === "violet";
  })()`, {
    timeoutMs: 60_000,
    label: "saved brand appearance controls",
  });
  await waitFor(browser, `(() => {
    const form = document.querySelector('[data-testid="brand-appearance-screen"] form');
    return Boolean(form && Object.keys(form).some((key) => key.startsWith("__reactProps$")));
  })()`, {
    timeoutMs: 60_000,
    label: "hydrated brand appearance form",
  });

  const presentation = await evalIn(browser, `(() => {
    const screen = document.querySelector('[data-testid="brand-appearance-screen"]');
    const fields = document.querySelector('[data-testid="brand-identity-fields"]');
    const applicationInput = document.querySelector('input[placeholder="OpenWork"]');
    const accentSelect = fields?.querySelector('select');
    const fieldRect = fields?.getBoundingClientRect();
    const applicationRect = applicationInput?.closest('label')?.getBoundingClientRect();
    const accentRect = accentSelect?.closest('label')?.getBoundingClientRect();
    const screenRect = screen?.getBoundingClientRect();
    const exactPreviewLabels = [...document.querySelectorAll('p, span, h1, h2, h3')]
      .filter((element) => (element.textContent ?? '').trim() === 'Preview').length;
    return {
      exactPreviewLabels,
      applicationName: applicationInput instanceof HTMLInputElement ? applicationInput.value : null,
      accentColor: accentSelect instanceof HTMLSelectElement ? accentSelect.value : null,
      applicationWidth: applicationRect?.width ?? 0,
      accentWidth: accentRect?.width ?? 0,
      fieldWidth: fieldRect?.width ?? 0,
      screenWithinViewport: Boolean(
        screenRect
          && screenRect.left >= 0
          && screenRect.right <= window.innerWidth,
      ),
      wordmark: document.body.innerText.includes('Wordmark'),
      squareIcon: document.body.innerText.includes('Square app icon'),
      chooseImageButtons: [...document.querySelectorAll('label')]
        .filter((label) => (label.textContent ?? '').includes('Choose image') || (label.textContent ?? '').includes('Replace image')).length,
      clearButtons: [...document.querySelectorAll('button')]
        .filter((button) => (button.textContent ?? '').trim() === 'Clear').length,
      fileInputs: document.querySelectorAll('input[type="file"][accept="image/png,image/jpeg"]').length,
      storedLogoStatus: document.body.innerText.includes('Current hosted image (legacy URL). Upload a file to move it into this Den.'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  expect(presentation).toMatchObject({
    exactPreviewLabels: 0,
    applicationName: initialName,
    accentColor: "violet",
    screenWithinViewport: true,
    wordmark: true,
    squareIcon: true,
    chooseImageButtons: 2,
    clearButtons: 2,
    fileInputs: 2,
    storedLogoStatus: true,
    horizontalOverflow: false,
  });
  if (!isRecord(presentation)) throw new Error("The Brand appearance layout facts were not an object.");
  expect(presentation.applicationWidth).toBe(presentation.fieldWidth);
  expect(presentation.accentWidth).toBe(presentation.fieldWidth);
  evidence.recordAssertionEvidence(
    "White-label Desktop identity has no Preview card or unused column at a narrow desktop width",
    `At 820px wide the page rendered ${JSON.stringify(presentation)}.`,
    presentation.exactPreviewLabels === 0
      && presentation.screenWithinViewport === true
      && presentation.horizontalOverflow === false
      && presentation.applicationWidth === presentation.fieldWidth
      && presentation.accentWidth === presentation.fieldWidth,
  );

  await fill(browser, 'input[placeholder="OpenWork"]', updatedName);
  const accentChanged = await evalIn(browser, `(() => {
    const select = document.querySelector('[data-testid="brand-identity-fields"] select');
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = 'teal';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  expect(accentChanged).toBe(true);
  const saveClicked = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? '').trim() === 'Save brand appearance');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
  expect(saveClicked).toBe(true);
  await expect.poll(async () => {
    const metadata = await organizationMetadata(den.admin, orgId);
    return {
      brandAppName: metadata.brandAppName,
      brandAccentColor: metadata.brandAccentColor,
    };
  }, {
    message: "brand appearance save did not reach the organization metadata",
    timeout: 30_000,
    interval: 250,
  }).toEqual({ brandAppName: updatedName, brandAccentColor: "teal" });

  await navigate(browser.client, `${den.ref.webUrl}/dashboard/brand-appearance`);
  await waitFor(browser, `(() => {
    const input = document.querySelector('input[placeholder="OpenWork"]');
    const select = document.querySelector('[data-testid="brand-identity-fields"] select');
    return input instanceof HTMLInputElement
      && input.value === ${JSON.stringify(updatedName)}
      && select instanceof HTMLSelectElement
      && select.value === "teal";
  })()`, {
    timeoutMs: 60_000,
    label: "restored saved brand appearance values",
  });
  const savedMetadata = await organizationMetadata(den.admin, orgId);
  expect(savedMetadata.brandAppName).toBe(updatedName);
  expect(savedMetadata.brandAccentColor).toBe("teal");
  expect(savedMetadata.brandLogoUrl).toBe(existingLogoUrl);
  evidence.recordAssertionEvidence(
    "Editable branding saves and restores without resetting the existing wordmark",
    `The page restored appName=${JSON.stringify(updatedName)} and accent=teal; the API retained ${existingLogoUrl}.`,
    savedMetadata.brandAppName === updatedName
      && savedMetadata.brandAccentColor === "teal"
      && savedMetadata.brandLogoUrl === existingLogoUrl,
  );
});
