import type { Seed } from "@openwork/env";

async function oidcRedirect(seed: Seed, split: boolean) {
  const web = "https://ow.ai.example.test";
  const api = split ? "https://api-ow.ai.example.test" : web;
  const den = await seed.den({ web: false, publicOrigins: { web, api }, org: {
    name: "Example Workspace", admin: { name: "Example Admin", email: "admin@example.test" }, members: {},
  } });
  return { den, webOrigin: web, apiOrigin: api, split };
}

export function singleOriginOidcRedirect(seed: Seed) { return oidcRedirect(seed, false); }
export function splitOriginOidcRedirect(seed: Seed) { return oidcRedirect(seed, true); }
