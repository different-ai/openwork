import { describe, expect, test } from "bun:test";
import {
  connectorPrompt,
  encodeConnectorToken,
  parseConnectorToken,
  seededConnectorDraft,
} from "../src/react-app/domains/session/surface/composer/connector-token";
import { takePendingDeepLinks } from "../src/app/lib/deep-link-bridge";

describe("connector composer token", () => {
  test("round-trips a connector name through the draft token", () => {
    expect(encodeConnectorToken("GitHub")).toBe("[connector GitHub]");
    expect(parseConnectorToken("[connector GitHub]")).toBe("GitHub");
    expect(parseConnectorToken("[connector Google Calendar]")).toBe("Google Calendar");
    expect(parseConnectorToken("[skill GitHub]")).toBeNull();
    expect(parseConnectorToken("plain text")).toBeNull();
  });

  test("keeps bracket characters out of the token so the chip boundary survives", () => {
    expect(encodeConnectorToken("Git[Hub]\n")).toBe("[connector GitHub]");
  });

  test("seeds the chip ahead of the prompt and leaves a bare prompt untouched", () => {
    expect(seededConnectorDraft({ connector: "GitHub", prompt: " Explain this repo " })).toBe("[connector GitHub] Explain this repo");
    expect(seededConnectorDraft({ connector: "GitHub", prompt: "" })).toBe("[connector GitHub] ");
    expect(seededConnectorDraft({ connector: null, prompt: "Explain this repo" })).toBe("Explain this repo");
  });

  test("steers discovery without assuming connection or authorizing setup and writes", () => {
    const prompt = connectorPrompt("GitHub");
    expect(prompt).toContain('This request is about the "GitHub" connector');
    expect(prompt).toContain("do not assume it is connected or that its tools are available");
    expect(prompt).toContain("Answer planning and general questions without requiring a connection");
    expect(prompt).toContain("discover capabilities normally with search_capabilities, omitting intent connect");
    expect(prompt).toContain("Offer setup only if the requested operation needs an unavailable connection or the user explicitly asks");
    expect(prompt).toContain("use intent connect only for an explicit setup request");
    expect(prompt).toContain("let the user authorize any connection themselves");
    expect(prompt).toContain("does not authorize sign-in, scope changes, or external writes");
    expect(prompt).toContain("perform writes only when explicitly requested");
  });
});

describe("takePendingDeepLinks", () => {
  test("removes only the links a consumer owns and leaves the rest queued", () => {
    const target = { __OPENWORK__: { deepLinks: ["openwork://chat?prompt=hi", "openwork://connect?token=abc"] } } as unknown as Window;
    expect(takePendingDeepLinks(target, (url) => url.startsWith("openwork://chat"))).toEqual(["openwork://chat?prompt=hi"]);
    expect(target.__OPENWORK__?.deepLinks).toEqual(["openwork://connect?token=abc"]);
    expect(takePendingDeepLinks(target, (url) => url.startsWith("openwork://chat"))).toEqual([]);
  });
});
