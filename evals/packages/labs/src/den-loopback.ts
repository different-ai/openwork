import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";

/** Send controlled proxy headers directly to Den, without the public preview proxy rewriting them. */
export async function requestDenLoopback(sandbox: string, path: string, init: RequestInit): Promise<Response> {
  const input = Buffer.from(JSON.stringify({
    path,
    method: init.method,
    headers: [...new Headers(init.headers)],
    body: init.body?.toString(),
  })).toString("base64");
  const source = `
    const input = JSON.parse(Buffer.from(process.argv[2], "base64").toString());
    const response = await fetch(new URL(input.path, "http://127.0.0.1:8788"), {
      method: input.method, headers: input.headers, body: input.body,
      redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    const headers = [...response.headers].filter(([name]) => name !== "set-cookie");
    for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
    console.log(JSON.stringify({ status: response.status, headers, body: await response.text() }));
  `;
  const encodedSource = Buffer.from(source).toString("base64");
  const result = await execInSandbox(defaultDaytonaExec, sandbox,
    `printf %s ${encodedSource} | base64 -d | node --input-type=module - ${input}`,
    { timeoutMs: 20_000, context: "Den loopback HTTP request" });
  const output: unknown = JSON.parse(result.stdout);
  if (typeof output !== "object" || output === null
    || !("status" in output) || typeof output.status !== "number"
    || !("body" in output) || typeof output.body !== "string"
    || !("headers" in output) || !Array.isArray(output.headers)) throw new Error("Invalid Den HTTP response");
  const headers = new Headers();
  for (const pair of output.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw new Error("Invalid Den HTTP response header");
    }
    headers.append(pair[0], pair[1]);
  }
  return new Response(output.body, { status: output.status, headers });
}
