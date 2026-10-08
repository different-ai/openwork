import { expect, test } from "vitest";
import { workbotProbeAuthorizeUrl } from "../../../../worlds/lib/workbot-auth.ts";
test("the probe uses the API that issued its cookie and preserves signed query parameters", () => {
  expect(workbotProbeAuthorizeUrl("https://den.example.com/api/auth/oauth2/authorize?state=a&sig=b", "https://den.example.com", "http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788/api/auth/oauth2/authorize?state=a&sig=b");
});
test("authorization cookies are never sent to another origin or route", () => {
  expect(() => workbotProbeAuthorizeUrl("https://untrusted.example.com/api/auth/oauth2/authorize", "https://den.example.com", "http://127.0.0.1:8788")).toThrow(/untrusted/);
  expect(() => workbotProbeAuthorizeUrl("https://den.example.com/unrelated", "https://den.example.com", "http://127.0.0.1:8788")).toThrow(/untrusted/);
});
