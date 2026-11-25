/**
 * Loaded before application instrumentation by isolated worlds (the DPA world,
 * fake-stripe.ts): refuses non-loopback egress and, with MODELS_STRIPE_PORT,
 * sends the Stripe SDK to a loopback fake.
 */
import http from "node:http";
import https from "node:https";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

function check(input) {
  const hostname = input instanceof URL ? input.hostname : input.hostname ?? input.host ?? "localhost";
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) return;
  // Never retain a URL, body, header or credential in assertion evidence.
  appendFileSync(process.env.MODELS_EGRESS_FILE, `${JSON.stringify({ hostname })}\n`);
  throw new Error("DPA fixture refused non-loopback HTTP egress");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  check(new URL(typeof input === "string" || input instanceof URL ? input : input.url));
  return originalFetch(input, { ...init, redirect: "error" });
};
for (const transport of [http, https]) {
  for (const method of ["request", "get"]) {
    const original = transport[method];
    transport[method] = function (input, ...args) {
      check(typeof input === "string" ? new URL(input) : input);
      return original.call(this, input, ...args);
    };
  }
}
syncBuiltinESMExports();

if (process.env.MODELS_STRIPE_PORT) {
  // Redirect the SDK transport, not any Den billing function. Every response
  // still crosses HTTP and is produced by the independent provider witness.
  // MODELS_STRIPE_KEY selects the synthetic key a world uses (fake-stripe.ts);
  // the DPA world keeps its historical key.
  const { redirectStripeSdk } = await import("./fake-stripe.mjs");
  await redirectStripeSdk({
    sdkRoot: new URL("../../../../ee/apps/den-api/node_modules/stripe/", import.meta.url),
    port: Number(process.env.MODELS_STRIPE_PORT),
    secretKey: process.env.MODELS_STRIPE_KEY || "sk_test_models_dpa_fixture_not_real",
  });
}
