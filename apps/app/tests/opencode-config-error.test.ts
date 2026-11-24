import { expect, test } from "bun:test";
import { isOpencodeConfigErrorMessage } from "@openwork/types/opencode-config-error";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { classifyRouteSessionReadError, listRouteSessions, type RouteSessionListTransport } from "../src/react-app/shell/route-workspaces";
import { presentOpencodeSessionError } from "../src/react-app/domains/session/sync/session-error";

// The body OpenCode 1.18 answers for every request in a folder whose
// opencode.json uses a v2 `reasoning` object inside a v1 provider block.
const configInvalid = {
  name: "ConfigInvalidError",
  data: {
    path: "/work/acme/opencode.json",
    issues: [{ path: ["provider", "anthropic", "models", "x", "reasoning"], message: "Expected boolean | undefined, got {\"supported\":true}" }],
  },
};
const expected = "OpenCode can't use the config file /work/acme/opencode.json: provider.anthropic.models.x.reasoning: Expected boolean | undefined, got {\"supported\":true}. Fix or remove that setting, then try again.";

test("a chat list refused for an invalid config says which file and field, instead of looking empty", async () => {
  const transport: RouteSessionListTransport = async () => ({
    error: configInvalid,
    request: new Request("http://127.0.0.1/session"),
    response: new Response(null, { status: 400 }),
  });
  // The transport is stubbed, so the endpoint's fields are never read.
  const endpoint: ResolvedWorkspaceEndpoint = Object.create(null);
  let thrown: unknown;
  try { await listRouteSessions(endpoint, transport); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown instanceof Error ? thrown.message : null).toBe(expected);
  expect(thrown instanceof Error && "code" in thrown ? thrown.code : null).toBe("opencode_config_invalid");
  expect(classifyRouteSessionReadError(thrown)).toBe("error");
  expect(isOpencodeConfigErrorMessage(expected)).toBe(true);
  expect(isOpencodeConfigErrorMessage("OpenCode request failed")).toBe(false);
});

test("a message refused for an invalid config shows the file and field", () => {
  const presentation = presentOpencodeSessionError(configInvalid);
  expect(presentation.kind).toBe("config-invalid");
  expect(presentation.title).toBe("OpenCode can’t use a config file");
  expect(presentation.description).toBe(expected);
});

test("the OpenWork server's config error keeps its message", () => {
  const presentation = presentOpencodeSessionError({ code: "opencode_config_invalid", message: expected });
  expect(presentation.kind).toBe("config-invalid");
  expect(presentation.description).toBe(expected);
});
