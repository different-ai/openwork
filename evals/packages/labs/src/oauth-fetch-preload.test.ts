import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const preload = fileURLToPath(new URL("./oauth-fetch-preload.ts", import.meta.url));

test("the test-only Google transport preserves token POST data and rejects unmapped Google traffic", async () => {
  const requests: Array<{ path: string; method: string | undefined; body: string; authorization: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    requests.push({ path: request.url ?? "", method: request.method, body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const program = `
      const token = await fetch('https://oauth2.googleapis.com/token', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Basic synthetic'}, body:'code=synthetic&grant_type=authorization_code'});
      if (!(await token.json()).ok) throw new Error('token response lost');
      await fetch('https://www.googleapis.com/oauth2/v3/certs');
      await fetch(new Request('https://www.googleapis.com/oauth2/v3/userinfo', {headers:{authorization:'Bearer synthetic'}}));
      await fetch('https://accounts.google.com/.well-known/openid-configuration');
      let blocked=false;
      try { await fetch('https://accounts.google.com/unmapped'); } catch(error) { blocked=error.message.includes('Unmapped Google request'); }
      if(!blocked) throw new Error('unmapped provider traffic escaped');
      await fetch(${JSON.stringify(`${origin}/unchanged`)});
    `;
    await exec(process.execPath, ["--import", preload, "--input-type=module", "-e", program], {
      env: { ...process.env, OPENWORK_TEST_OAUTH_ORIGIN: origin }, timeout: 15_000,
    });
    expect(requests).toHaveLength(5);
    expect(requests[0]).toEqual({ path: "/token", method: "POST", body: "code=synthetic&grant_type=authorization_code", authorization: "Basic synthetic" });
    expect(requests[2]).toMatchObject({ path: "/oauth2/v3/userinfo", authorization: "Bearer synthetic" });
    expect(requests.map((request) => request.path)).toEqual(["/token", "/oauth2/v3/certs", "/oauth2/v3/userinfo", "/.well-known/openid-configuration", "/unchanged"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the preload refuses a non-loopback destination before replacing fetch", async () => {
  await expect(exec(process.execPath, ["--import", preload, "-e", ""], {
    env: { ...process.env, OPENWORK_TEST_OAUTH_ORIGIN: "https://provider.example.test" }, timeout: 10_000,
  })).rejects.toThrow(/loopback HTTP origin/);
});
