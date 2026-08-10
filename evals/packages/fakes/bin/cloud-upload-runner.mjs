import { callOpenWorkCloudUploadAction } from "../../../../apps/server/src/extensions/cloud-uploads.ts";
import { listExperimentalExtensionActions } from "../../../../apps/server/src/extensions/index.ts";

const input = JSON.parse(await Bun.stdin.text());

if (input.mode === "inspect") {
  process.stdout.write(JSON.stringify({ ok: true, result: listExperimentalExtensionActions("") }));
} else {
  let networkCalls = 0;
  const config = {
    host: "127.0.0.1",
    port: 8787,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: `${input.root}/server.json`,
    approval: { mode: "auto", timeoutMs: 30_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [input.root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
  try {
    const result = await callOpenWorkCloudUploadAction(
      config,
      input.action,
      input.args,
      input.context,
      {
        readCloudMcp: async () => ({
          type: "remote",
          enabled: true,
          url: input.cloudUrl,
          headers: { Authorization: `Bearer ${input.mcpToken}` },
          oauth: false,
        }),
        fetchImpl: async (url, init) => {
          networkCalls += 1;
          return fetch(url, init);
        },
      },
    );
    process.stdout.write(JSON.stringify({ ok: true, result, networkCalls }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      status: error && typeof error === "object" && "status" in error ? error.status : null,
      code: error && typeof error === "object" && "code" in error ? error.code : null,
      message: error instanceof Error ? error.message : String(error),
      networkCalls,
    }));
  }
}
