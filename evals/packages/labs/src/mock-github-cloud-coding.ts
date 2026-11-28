import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { startAcmeGithubGit } from "./mock-github-cloud-coding-git.ts";

export const acmeCloudCodingRepositories = ["acme/storefront", "acme/billing-api", "acme/docs", "acme/mobile-app"] as const;
type RepositoryName = typeof acmeCloudCodingRepositories[number];
const users = {
  "maya-chen": { id: 101, login: "maya-chen", name: "Maya Chen" },
  "sam-rivera": { id: 102, login: "sam-rivera", name: "Sam Rivera" },
};
type Login = keyof typeof users;
const callbackPath = "/dashboard/cloud-coding/github/callback";
const installationId = 51;
const slug = "acme-cloud-coding";
const appId = "42";
const clientId = slug;
const repositories = acmeCloudCodingRepositories.map((full_name, index) => ({
  id: 201 + index, full_name, default_branch: "main", private: true, archived: false,
}));

export interface MockGithubCloudCodingHandle extends AsyncDisposable {
  env: Record<string, string>;
  setDenWebOrigin(origin: string): void;
  signInAs(login: Login): void;
  setRepositories(names: readonly RepositoryName[]): void;
  stop(): Promise<void>;
}

function json(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: URL) {
  response.writeHead(303, { location: location.href, "cache-control": "no-store" });
  response.end();
}

function html(response: ServerResponse, title: string, content: string) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
    <style>body{font:16px system-ui;color:#1f2328;background:#f6f8fa} main{max-width:480px;margin:12vh auto;padding:32px;background:white;border:1px solid #d1d9e0;border-radius:10px} h1{font-size:24px} button{font:inherit;font-weight:600;padding:8px 14px;color:white;background:#1a7f37;border:0;border-radius:6px;cursor:pointer} li{margin-block:8px}</style>
    <main><h1>${title}</h1>${content}</main></html>`);
}

async function bodyText(request: IncomingMessage) {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

/** GitHub's external HTTP seam for the browser proof. No calls leave this lab. */
export async function startMockGithubCloudCoding(options: { gitDirectory?: string } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const clientSecret = randomUUID();
  const webhookSecret = randomUUID();
  const basicAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const codes = new Map<string, Login>();
  const userTokens = new Map<string, { login: Login; refresh: string }>();
  const installTokens = new Map<string, { expires: number; ids?: number[]; contents?: string }>();
  const isInstallationToken = (token: string) => (installTokens.get(token)?.expires ?? 0) > Date.now();
  const requestScope = z.object({ repository_ids: z.array(z.number()).optional(), permissions: z.object({ contents: z.string().optional() }).optional() });
  const confirmations = new Map<string, { state: string; login: Login }>();
  let denWebOrigin: string | undefined;
  let login: Login = "maya-chen";
  let installed = false;
  let selected = [...repositories];
  let base = "";
  const settingsPath = `/organizations/acme/settings/installations/${installationId}`;
  const installation = () => ({
    id: installationId, account: { id: 301, login: "acme", type: "Organization" },
    repository_selection: "selected", suspended_at: null, html_url: `${base}${settingsPath}`,
  });

  function validAppToken(token: string) {
    const [header, claims, signature, extra] = token.split(".");
    if (!header || !claims || !signature || extra !== undefined) return false;
    const decoded: unknown = JSON.parse(Buffer.from(claims, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    return typeof decoded === "object" && decoded !== null && "iss" in decoded && decoded.iss === appId
      && "iat" in decoded && typeof decoded.iat === "number" && decoded.iat <= now
      && "exp" in decoded && typeof decoded.exp === "number" && decoded.exp > now && decoded.exp <= now + 600
      && verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"));
  }

  function authorize(response: ServerResponse, url: URL, state: string, who: Login, install = false) {
    const code = randomUUID();
    codes.set(code, who);
    url.search = new URLSearchParams({ code, state, ...(install ? { installation_id: String(installationId), setup_action: "install" } : {}) }).toString();
    redirect(response, url);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", base);
    const route = `${request.method} ${url.pathname}`;
    const state = url.searchParams.get("state");
    const callback = denWebOrigin ? new URL(callbackPath, denWebOrigin) : undefined;
    const installPath = `/apps/${slug}/installations/new`;
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    const user = userTokens.get(token);
    const notFound = () => json(response, 404, { message: "Not found" });
    const unauthorized = () => json(response, 401, { message: "Bad credentials" });

    if (route === `GET ${installPath}` && state && callback) {
      const confirmation = randomUUID();
      confirmations.set(confirmation, { state, login });
      return html(response, "Install & Authorize OpenWork", `<p>Install OpenWork for Acme Corp as <strong>${login}</strong>.</p>
        <p>Selected repositories:</p><ul>${selected.map(repo => `<li>${repo.full_name}</li>`).join("")}</ul>
        <form method="post"><input type="hidden" name="confirmation" value="${confirmation}"><button>Install & Authorize</button></form>`);
    }
    if (route === `POST ${installPath}` && callback) {
      const key = new URLSearchParams(await bodyText(request)).get("confirmation") ?? "";
      const confirmation = confirmations.get(key);
      if (!confirmation) return json(response, 400);
      confirmations.delete(key);
      installed = true;
      return authorize(response, callback, confirmation.state, confirmation.login, true);
    }
    if (route === `GET ${settingsPath}` && installed) {
      return html(response, "OpenWork repository access", `<p>Selected repositories:</p><ul>${selected.map(repo => `<li>${repo.full_name}</li>`).join("")}</ul>`);
    }
    if (route === "GET /login/oauth/authorize" && state && callback
        && url.searchParams.get("client_id") === clientId && url.searchParams.get("redirect_uri") === callback.href) {
      return authorize(response, callback, state, login);
    }
    if (route === "POST /login/oauth/access_token") {
      const params = new URLSearchParams(await bodyText(request));
      if (params.get("client_id") !== clientId || params.get("client_secret") !== clientSecret) {
        return json(response, 200, { error: "incorrect_client_credentials" });
      }
      let who: Login | undefined;
      if (params.get("grant_type") === "refresh_token") {
        const current = [...userTokens].find(([, entry]) => entry.refresh === params.get("refresh_token"));
        if (!current) return json(response, 200, { error: "bad_refresh_token" });
        who = current[1].login;
        userTokens.delete(current[0]);
      } else {
        const code = params.get("code") ?? "";
        who = codes.get(code);
        if (!who || !callback || params.get("redirect_uri") !== callback.href) return json(response, 200, { error: "bad_verification_code" });
        codes.delete(code);
      }
      const access = `ghu_${randomUUID()}`;
      const refresh = `ghr_${randomUUID()}`;
      userTokens.set(access, { login: who, refresh });
      return json(response, 200, { access_token: access, expires_in: 28_800, refresh_token: refresh, refresh_token_expires_in: 7_776_000 });
    }
    if (route === `DELETE /applications/${clientId}/token`) {
      if (request.headers.authorization !== basicAuth) return unauthorized();
      const input: unknown = JSON.parse(await bodyText(request));
      if (typeof input !== "object" || input === null || !("access_token" in input) || typeof input.access_token !== "string") return json(response, 422);
      return json(response, userTokens.delete(input.access_token) ? 204 : 404);
    }
    if (url.pathname.startsWith("/app/installations/")) {
      if (!validAppToken(token)) return unauthorized();
      if (!installed) return notFound();
      if (route === `GET /app/installations/${installationId}`) return json(response, 200, installation());
      if (route === `POST /app/installations/${installationId}/access_tokens`) {
        const access = `ghs_${randomUUID()}`;
        const expires = Date.now() + 3_600_000;
        const scope = requestScope.parse(JSON.parse(await bodyText(request)));
        if (scope.repository_ids?.some(id => !selected.some(repo => repo.id === id))) return notFound();
        installTokens.set(access, { expires, ids: scope.repository_ids, contents: scope.permissions?.contents });
        return json(response, 201, { token: access, expires_at: new Date(expires).toISOString() });
      }
    }
    if (route === "GET /user") return user ? json(response, 200, users[user.login]) : unauthorized();
    if (route === "GET /user/installations") {
      if (!user) return unauthorized();
      const installations = installed ? [installation()] : [];
      return json(response, 200, { total_count: installations.length, installations });
    }
    const installationToken = isInstallationToken(token);
    if (route === "GET /installation/repositories") {
      return installationToken ? json(response, 200, { total_count: selected.length, repositories: selected }) : unauthorized();
    }
    if (installed && (user || installationToken) && request.method === "GET") {
      const repository = selected.find(repo => url.pathname === `/repositories/${repo.id}` || url.pathname === `/repos/${repo.full_name}`);
      if (repository) return json(response, 200, repository);
    }
    if (await git?.handle(request, response, url, {
      userLogin: user?.login,
      installationToken: token,
      installationExists: isInstallationToken,
      repositorySelected: name => installed && selected.some(repo => repo.full_name === name),
      installationCanRead: (candidate, name) => {
        const scope = installTokens.get(candidate);
        return installed && isInstallationToken(candidate) && scope?.contents === "read"
          && selected.some(repo => repo.full_name === name && scope.ids?.includes(repo.id));
      },
    })) return;
    return notFound();
  }

  await using setup = new AsyncDisposableStack();
  const git = options.gitDirectory === undefined ? undefined : setup.use(await startAcmeGithubGit(acmeCloudCodingRepositories, options.gitDirectory));
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => json(res, 400, { message: "Invalid request" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The GitHub lab did not bind an HTTP port.");
  base = `http://127.0.0.1:${address.port}`;
  setup.defer(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const resources = setup.move();
  const stop = () => resources.disposeAsync();
  return {
    env: {
      GITHUB_CLOUD_CODING_APP_ID: appId,
      GITHUB_CLOUD_CODING_APP_SLUG: slug,
      GITHUB_CLOUD_CODING_APP_CLIENT_ID: clientId,
      GITHUB_CLOUD_CODING_APP_CLIENT_SECRET: clientSecret,
      GITHUB_CLOUD_CODING_APP_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      GITHUB_CLOUD_CODING_APP_WEBHOOK_SECRET: webhookSecret,
      GITHUB_CLOUD_CODING_API_BASE: base,
      GITHUB_CLOUD_CODING_WEB_BASE: base,
    },
    git,
    setDenWebOrigin(origin: string) { denWebOrigin = new URL(origin).origin; },
    signInAs(who: Login) { login = who; },
    setRepositories(names: readonly RepositoryName[]) { selected = repositories.filter(repo => names.includes(repo.full_name)); },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
