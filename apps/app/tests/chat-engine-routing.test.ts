import { expect, test } from "bun:test";

import { createOpenworkServerClient, OpenworkServerError } from "../src/app/lib/openwork-server";
import { readChatRoutesToV2 } from "../src/react-app/domains/models/use-chat-engine-client";

type ServerClient = ReturnType<typeof createOpenworkServerClient>;
function endpoint(status: () => Promise<Awaited<ReturnType<ServerClient["getEngineV2PreviewStatus"]>>>) {
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:1", token: "t" });
  return { client: { ...client, getEngineV2PreviewStatus: status } };
}

test("Settings reads models from v2 when chat runs on v2", async () => {
  const status = { enabled: true, running: true, chatRouting: true, mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [] };
  expect(await readChatRoutesToV2(endpoint(async () => status))).toBe(true);
  expect(await readChatRoutesToV2(endpoint(async () => ({ ...status, chatRouting: false })))).toBe(false);
});

test("a server without the v2 status route is v1; other failures are not guessed", async () => {
  expect(await readChatRoutesToV2(endpoint(async () => { throw new OpenworkServerError(404, "not_found", "missing"); }))).toBe(false);
  await expect(readChatRoutesToV2(endpoint(async () => { throw new OpenworkServerError(503, "unavailable", "down"); }))).rejects.toThrow("down");
});
