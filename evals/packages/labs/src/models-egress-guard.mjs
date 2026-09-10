/** Loaded only by the isolated DPA world, before application instrumentation. */
import http from "node:http";
import https from "node:https";
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

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
  const sdk = new URL("../../../../ee/apps/den-api/node_modules/stripe/", import.meta.url);
  const esm = await import(new URL("esm/net/NodeHttpClient.js", sdk));
  const cjs = createRequire(import.meta.url)(fileURLToPath(new URL("cjs/net/NodeHttpClient.js", sdk)));
  for (const { NodeHttpClient } of [esm, cjs]) {
    const makeRequest = NodeHttpClient.prototype.makeRequest;
    NodeHttpClient.prototype.makeRequest = function (host, port, path, method, headers, body, protocol, timeout) {
      const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
      if (host !== "api.stripe.com" || authorization !== "Bearer sk_test_models_dpa_fixture_not_real") {
        throw new Error("DPA Stripe transport requires the synthetic credential and expected SDK host");
      }
      return makeRequest.call(this, "127.0.0.1", Number(process.env.MODELS_STRIPE_PORT), `/stripe${path}`, method, headers, body, "http", Math.min(timeout, 5_000));
    };
  }
}
