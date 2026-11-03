import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_IP_SIGNATURE_HEADER, SIGNED_CLIENT_IP_HEADER, verifyClientIpSignature } from "@openwork-ee/utils/client-ip-signature";
import { applySignedClientIp, platformClientIp } from "./signed-client-ip";

const secret = "den-web-client-ip-secret-for-tests-0123456789";
const vercel = { VERCEL: "1", DEN_WEB_CLIENT_IP_SECRET: secret };

test("on Vercel, the address Vercel saw is signed for Den API", () => {
  const upstream = new Headers({ "x-forwarded-for": "198.51.100.7" });
  applySignedClientIp(upstream, new Headers({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "198.51.100.7" }), vercel);
  assert.equal(upstream.get(SIGNED_CLIENT_IP_HEADER), "198.51.100.7");
  assert.equal(verifyClientIpSignature(secret, "198.51.100.7", upstream.get(CLIENT_IP_SIGNATURE_HEADER) ?? ""), true);
});

test("a caller's own signed-address headers never reach Den API", () => {
  const upstream = new Headers({ [SIGNED_CLIENT_IP_HEADER]: "203.0.113.9", [CLIENT_IP_SIGNATURE_HEADER]: "t=1,v1=forged" });
  applySignedClientIp(upstream, new Headers({ "x-forwarded-for": "198.51.100.7" }), { DEN_WEB_CLIENT_IP_SECRET: secret });
  assert.equal(upstream.get(SIGNED_CLIENT_IP_HEADER), null, "off Vercel nothing is vouched for");
  assert.equal(upstream.get(CLIENT_IP_SIGNATURE_HEADER), null);

  const unsigned = new Headers({ [SIGNED_CLIENT_IP_HEADER]: "203.0.113.9" });
  applySignedClientIp(unsigned, new Headers({ "x-vercel-forwarded-for": "198.51.100.7" }), { VERCEL: "1" });
  assert.equal(unsigned.get(SIGNED_CLIENT_IP_HEADER), null, "without a secret nothing is vouched for");
});

test("only a real address from the platform is used", () => {
  assert.equal(platformClientIp(new Headers({ "x-real-ip": "2001:db8::7" }), vercel), "2001:db8::7");
  assert.equal(platformClientIp(new Headers({ "x-vercel-forwarded-for": "unknown" }), vercel), null);
  assert.equal(platformClientIp(new Headers({ "x-vercel-forwarded-for": "198.51.100.7" }), {}), null);
});
