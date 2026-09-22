import { readFile, writeFile } from "node:fs/promises";
// This script must not launch/reseed any process. All services are already alive.
const root = "/opt/openwork-preview";
const services = JSON.parse(await readFile(`${root}/services.json`, "utf8"));
const outputs = JSON.parse(await readFile(`${root}/outputs.json`, "utf8"));
await readFile(`${root}/ready-world`, "utf8");
for (const service of ["api", "gateway"]) {
  const response = await fetch(`${services[service]}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Restored ${service} is unavailable`);
}
// Session expiration uses wall time. Renew only when the frozen token expired.
const session = await fetch(`${services.api}/v1/me/orgs`, {
  headers: { authorization: `Bearer ${outputs.denToken.value}` }, signal: AbortSignal.timeout(10_000),
});
if (!session.ok) {
  const login = await fetch(`${services.api}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: outputs.alexEmail.value, password: outputs.alexPassword.value }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!login.ok) throw new Error("Could not renew the restored demo session");
  const account = await login.json();
  if (typeof account.token !== "string") throw new Error("Missing renewed demo token");
  const synced = await fetch(`${services.engine}/den-session`, {
    method: "PUT", headers: { "x-openwork-host-token": outputs.openworkHostToken.value, "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: services.api, token: account.token, orgId: outputs.orgId.value }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!synced.ok) throw new Error("Could not renew the restored engine connection");
  outputs.denToken.value = account.token;
  await writeFile(`${root}/outputs.json`, JSON.stringify(outputs), { mode: 0o600 });
}
await import("./health.mjs");
