import { afterEach, describe, expect, test } from "bun:test";

import { readPublicWebOrigin } from "../app/_lib/public-web-origin";
import { GET } from "../app/api/ready/route";

const originalEnv = {
  DEN_API_BASE: process.env.DEN_API_BASE,
  DEN_AUTH_ORIGIN: process.env.DEN_AUTH_ORIGIN,
  DEN_BASE_URL: process.env.DEN_BASE_URL,
  DEN_WEB_PUBLIC_ORIGIN: process.env.DEN_WEB_PUBLIC_ORIGIN,
};

function restoreEnvValue(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnvValue("DEN_API_BASE");
  restoreEnvValue("DEN_AUTH_ORIGIN");
  restoreEnvValue("DEN_BASE_URL");
  restoreEnvValue("DEN_WEB_PUBLIC_ORIGIN");
});

describe("Den public web origin", () => {
  test("derives the public web origin from DEN_BASE_URL before the migration fallback", () => {
    expect(readPublicWebOrigin({
      DEN_BASE_URL: "cloud.example.test",
      DEN_WEB_PUBLIC_ORIGIN: "https://migration.example.test",
    })).toBe("https://cloud.example.test");
  });

  test("keeps DEN_WEB_PUBLIC_ORIGIN as a migration fallback", () => {
    expect(readPublicWebOrigin({
      DEN_WEB_PUBLIC_ORIGIN: "https://migration.example.test",
    })).toBe("https://migration.example.test");
  });

  test("readiness requires DEN_BASE_URL instead of DEN_AUTH_ORIGIN", async () => {
    process.env.DEN_API_BASE = "https://api.internal.example.test";
    process.env.DEN_AUTH_ORIGIN = "https://legacy-auth.example.test";
    delete process.env.DEN_BASE_URL;
    const missingBaseResponse = await GET();
    const missingBasePayload = await missingBaseResponse.json();

    expect(missingBaseResponse.status).toBe(503);
    expect(missingBasePayload.missing).toEqual(["DEN_BASE_URL"]);

    process.env.DEN_BASE_URL = "https://cloud.example.test";
    delete process.env.DEN_AUTH_ORIGIN;
    process.env.DEN_API_BASE = "";
    const configuredBaseResponse = await GET();
    const configuredBasePayload = await configuredBaseResponse.json();

    expect(configuredBasePayload.missing).toBeUndefined();
  });
});
