import { describe, expect, test } from "bun:test";

import { parseRemoteConnectDeepLink } from "../src/app/lib/openwork-links";

describe("parseRemoteConnectDeepLink", () => {
  test("accepts client-token-only remote connect links", () => {
    expect(parseRemoteConnectDeepLink("openwork://connect-remote?openworkHostUrl=https%3A%2F%2Fworker.example.test&openworkClientToken=client-token")).toMatchObject({
      openworkHostUrl: "https://worker.example.test",
      openworkToken: "client-token",
      openworkClientToken: "client-token",
    });
  });

  test("prefers client token over legacy access token", () => {
    expect(parseRemoteConnectDeepLink("openwork://connect-remote?openworkHostUrl=https%3A%2F%2Fworker.example.test&openworkToken=legacy-token&openworkClientToken=client-token")).toMatchObject({
      openworkToken: "client-token",
      openworkClientToken: "client-token",
    });
  });

  test("falls back when client token is blank", () => {
    expect(parseRemoteConnectDeepLink("openwork://connect-remote?openworkHostUrl=https%3A%2F%2Fworker.example.test&openworkToken=legacy-token&openworkClientToken=%20%20")).toMatchObject({
      openworkToken: "legacy-token",
      openworkClientToken: null,
    });
  });
});
