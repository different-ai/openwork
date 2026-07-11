import { describe, expect, test } from "bun:test";

import {
  parseConnectDeepLink,
  parseDebugDeepLinkInput,
} from "../src/app/lib/openwork-links";

const TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJmYWtlIjoxfQ.c2ln";

describe("parseConnectDeepLink", () => {
  test("parses the canonical connect deep link", () => {
    const rawUrl = `openwork://connect?token=${TOKEN}`;
    expect(parseConnectDeepLink(rawUrl)).toEqual({ rawUrl, token: TOKEN });
  });

  test("accepts the dev scheme and slash forms", () => {
    expect(parseConnectDeepLink(`openwork-dev://connect?token=${TOKEN}`)?.token).toBe(TOKEN);
    expect(parseConnectDeepLink(`openwork:///connect?token=${TOKEN}`)?.token).toBe(TOKEN);
  });

  test("rejects http(s) forms — signed tokens do not ride web URLs", () => {
    expect(parseConnectDeepLink(`https://connect?token=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink(`https://openwork.example.com/connect?token=${TOKEN}`)).toBeNull();
  });

  test("rejects other routes, missing tokens, and junk", () => {
    expect(parseConnectDeepLink(`openwork://den-auth?grant=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink("openwork://connect")).toBeNull();
    expect(parseConnectDeepLink("openwork://connect?token=")).toBeNull();
    expect(parseConnectDeepLink("not a url")).toBeNull();
    expect(parseConnectDeepLink("")).toBeNull();
  });
});

describe("parseDebugDeepLinkInput connect arm", () => {
  test("routes pasted connect links to the connect arm", () => {
    const parsed = parseDebugDeepLinkInput(`  openwork://connect?token=${TOKEN}  `);
    expect(parsed?.kind).toBe("connect");
    if (parsed?.kind === "connect") {
      expect(parsed.link.token).toBe(TOKEN);
    }
  });

  test("extracts a connect link embedded in surrounding text", () => {
    const parsed = parseDebugDeepLinkInput(`click here: openwork://connect?token=${TOKEN} thanks`);
    expect(parsed?.kind).toBe("connect");
  });

  test("still routes den-auth links to the auth arm", () => {
    const parsed = parseDebugDeepLinkInput("openwork://den-auth?grant=abcdefghijkl");
    expect(parsed?.kind).toBe("auth");
  });
});
