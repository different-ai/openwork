import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_OPENWORK_WEB_URL } from "../app/(den)/_lib/runtime-config";
import { getWebPageAccessState, WebOpenButton } from "../app/(den)/dashboard/web/page";
import { GET } from "../app/api/runtime-config/route";

const originalEnv = {
  DEN_API_BASE: process.env.DEN_API_BASE,
  DEN_WEB_OPENWORK_WEB_URL: process.env.DEN_WEB_OPENWORK_WEB_URL,
};

function restoreEnvValue(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function readStringProperty(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const property = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof property === "string" ? property : null;
}

afterEach(() => {
  restoreEnvValue("DEN_API_BASE");
  restoreEnvValue("DEN_WEB_OPENWORK_WEB_URL");
});

describe("Web dashboard page", () => {
  test("uses the existing cloud capability gate", () => {
    expect(getWebPageAccessState({
      orgBusy: false,
      hasOrgContext: true,
      cloudEnabled: false,
      runtimeConfigLoaded: true,
    })).toBe("not-found");

    expect(getWebPageAccessState({
      orgBusy: false,
      hasOrgContext: true,
      cloudEnabled: true,
      runtimeConfigLoaded: true,
    })).toBe("ready");
  });

  test("renders the external Web button with the configured href", () => {
    const html = renderToStaticMarkup(createElement(WebOpenButton, {
      openworkWebUrl: DEFAULT_OPENWORK_WEB_URL,
    }));

    expect(html).toContain(`href="${DEFAULT_OPENWORK_WEB_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open OpenWork Web");
  });

  test("runtime config exposes the default Web URL and deployment override", async () => {
    delete process.env.DEN_API_BASE;
    delete process.env.DEN_WEB_OPENWORK_WEB_URL;

    const defaultPayload: unknown = await (await GET()).json();
    expect(readStringProperty(defaultPayload, "openworkWebUrl")).toBe(DEFAULT_OPENWORK_WEB_URL);

    process.env.DEN_WEB_OPENWORK_WEB_URL = "https://self-hosted.example.test";
    const overridePayload: unknown = await (await GET()).json();
    expect(readStringProperty(overridePayload, "openworkWebUrl")).toBe("https://self-hosted.example.test");
  });
});
