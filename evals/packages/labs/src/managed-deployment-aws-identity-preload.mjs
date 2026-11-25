/**
 * AWS identity fixture for worlds that play a customer's AWS account against
 * Den's managed-deployment routes; never loaded by production.
 *
 * Den's only call to AWS on the install, enroll and heartbeat paths is the
 * replay of a signed GetCallerIdentity request to the regional STS endpoint.
 * This answers that one request locally, for the fixture account, as the role
 * the world names in `x-amz-security-token`. Every other request to an
 * amazonaws.com host is refused in this process: fetch and http(s) throw, and
 * the name never resolves, so nothing the fixture does not answer can leave
 * the machine.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const LOG = "Managed deployment AWS identity fixture:";
const ACCOUNT = "123456789012";
const STS_HOST = /^sts\.([a-z]{2}(?:-[a-z]+)+-[1-9])\.amazonaws\.com$/;
const STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15";
const ROLE_TOKEN = /^fixture-role\/([A-Za-z0-9+=,.@_-]{1,64})$/;
const LOADED = Symbol.for("openwork.fixture.managedDeploymentAwsIdentity");

// Standard error: every Node process a world starts loads this, and some of them print data on standard output.
function note(entry) {
  process.stderr.write(`${LOG} ${JSON.stringify(entry)}\n`);
}

function isAws(hostname) {
  const name = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return name === "amazonaws.com" || name.endsWith(".amazonaws.com");
}

function refuse(hostname, via) {
  // Only the host and the layer that stopped it: never a path, header or body.
  note({ event: "refused", host: String(hostname).toLowerCase(), via });
  const error = new Error(`The AWS identity fixture refused a request to ${hostname}: only the signed STS GetCallerIdentity replay is answered, and nothing is sent to AWS.`);
  error.code = "EAI_FAIL";
  return error;
}

function denied(code) {
  return new Response(`<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code></Error></ErrorResponse>`, { status: 403, headers: { "content-type": "text/xml" } });
}

async function answerSts(region, input, init) {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
  const role = ROLE_TOKEN.exec(headers.get("x-amz-security-token") ?? "")?.[1];
  const signed = (headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256 ") && Boolean(headers.get("x-amz-date")) && Boolean(headers.get("x-openwork-proof"));
  if (method !== "POST" || body !== STS_BODY || !signed || !role) {
    note({ event: "denied", region });
    return denied("InvalidClientTokenId");
  }
  note({ event: "answered", region, account: ACCOUNT, role });
  return new Response(
    `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${ACCOUNT}:assumed-role/${role}/fixture-session</Arn><UserId>AROAFIXTURE:fixture-session</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
    { headers: { "content-type": "text/xml" } },
  );
}

function install() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!isAws(url.hostname)) return originalFetch(input, init);
    const region = STS_HOST.exec(url.hostname)?.[1];
    if (!region || url.protocol !== "https:" || url.port || url.pathname !== "/" || url.search) throw refuse(url.hostname, "fetch");
    return answerSts(region, input, init);
  }, originalFetch);

  for (const transport of [http, https]) {
    for (const method of ["request", "get"]) {
      const original = transport[method];
      transport[method] = function (input, ...rest) {
        const hostname = typeof input === "string" ? new URL(input).hostname : input instanceof URL ? input.hostname : input?.hostname ?? input?.host;
        if (isAws(String(hostname ?? "").replace(/:\d+$/, ""))) throw refuse(hostname, transport === https ? "https" : "http");
        return original.call(this, input, ...rest);
      };
    }
  }

  // The floor under every client, whatever library opens the socket: the name does not resolve.
  const lookup = dns.lookup;
  dns.lookup = function (hostname, ...rest) {
    if (!isAws(hostname)) return lookup.call(this, hostname, ...rest);
    const callback = rest.at(-1);
    const error = refuse(hostname, "dns");
    if (typeof callback === "function") process.nextTick(callback, error);
    return {};
  };
  const promiseLookup = dns.promises.lookup;
  dns.promises.lookup = function (hostname, ...rest) {
    return isAws(hostname) ? Promise.reject(refuse(hostname, "dns")) : promiseLookup.call(this, hostname, ...rest);
  };
  syncBuiltinESMExports();
}

if (!globalThis[LOADED]) {
  globalThis[LOADED] = true;
  install();
  // `entry` lets a world tell the served API process from the tools that started it.
  note({ event: "loaded", pid: process.pid, entry: process.argv[1] ?? null });
}
