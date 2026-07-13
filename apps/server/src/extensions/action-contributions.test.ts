import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ConnectSnapshot } from "../connect-contract.js";
import { createExtensionActionService } from "./action-service.js";
import {
  createGoogleWorkspaceActionContributions,
  GOOGLE_WORKSPACE_EXTENSION_ACTIONS,
  type GoogleWorkspaceActionOperations,
  type GoogleWorkspaceConnectPolicy,
} from "./google-workspace-actions.js";
import {
  createOpenAiImageGenerationActionContributions,
  OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS,
} from "./openai-image-generation-actions.js";

const ungatedSnapshot: ConnectSnapshot = {
  connectEnabled: false,
  cloudMcpPresent: false,
  googleWorkspace: { legacyConfigured: false },
};

const gatedSnapshot: ConnectSnapshot = {
  connectEnabled: true,
  cloudMcpPresent: true,
  googleWorkspace: { legacyConfigured: false },
};

const policy: GoogleWorkspaceConnectPolicy = {
  isGated: (snapshot) => snapshot.connectEnabled && !snapshot.googleWorkspace.legacyConfigured,
  guidance: (snapshot) => `Connect guidance (${snapshot.cloudMcpPresent})`,
  statusExtra: (snapshot) => ({ connect: { enabled: true, cloudMcpPresent: snapshot.cloudMcpPresent } }),
};

function googleOperations(calls: string[], observed: {
  statusExtra?: Record<string, unknown>;
  draftContext?: Record<string, unknown>;
}): GoogleWorkspaceActionOperations {
  const record = async (name: string) => {
    calls.push(name);
    return { operation: name };
  };
  return {
    status: async (extra) => {
      observed.statusExtra = extra;
      return record("status");
    },
    calendarListEvents: () => record("calendar_list_events"),
    gmailCreateDraft: async (_args, clientContext) => {
      observed.draftContext = clientContext;
      return record("gmail_create_draft");
    },
    gmailCreateReplyDraft: () => record("gmail_create_reply_draft"),
    gmailListMessages: () => record("gmail_list_messages"),
    gmailGetMessage: () => record("gmail_get_message"),
    gmailDownloadAttachment: () => record("gmail_download_attachment"),
    driveSearchFiles: () => record("drive_search_files"),
    driveReadFile: () => record("drive_read_file"),
    driveUpdateFile: () => record("drive_update_file"),
    calendarCreateEvent: () => record("calendar_create_event"),
    chatListSpaces: () => record("chat_list_spaces"),
    chatListMessages: () => record("chat_list_messages"),
    chatSendMessage: () => record("chat_send_message"),
  };
}

function serviceForGoogle(operations: GoogleWorkspaceActionOperations) {
  const contributions = createGoogleWorkspaceActionContributions(operations, policy);
  return createExtensionActionService({
    list: () => [...contributions],
    lookup: (extensionId, action) => contributions.find((item) => (
      item.descriptor.extensionId === extensionId && item.descriptor.action === action
    )),
  });
}

describe("Google Workspace action contributions", () => {
  test("keep all fourteen descriptors in their existing byte order", () => {
    expect(GOOGLE_WORKSPACE_EXTENSION_ACTIONS.map((item) => item.action)).toEqual([
      "status",
      "calendar_list_events",
      "gmail_create_draft",
      "gmail_create_reply_draft",
      "gmail_list_messages",
      "gmail_get_message",
      "gmail_download_attachment",
      "drive_search_files",
      "drive_read_file",
      "drive_update_file",
      "calendar_create_event",
      "chat_list_spaces",
      "chat_list_messages",
      "chat_send_message",
    ]);
    const descriptorBytes = JSON.stringify([
      ...GOOGLE_WORKSPACE_EXTENSION_ACTIONS,
      ...OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS,
    ]);
    expect(createHash("sha256").update(descriptorBytes).digest("hex")).toBe(
      "740be3216c545ce10b78390816eabad6cbf45d754fc8574a559a68d1b42ce9d1",
    );
  });

  test("maps every descriptor to its operation and passes client context only to Gmail draft", async () => {
    const calls: string[] = [];
    const observed: { statusExtra?: Record<string, unknown>; draftContext?: Record<string, unknown> } = {};
    const service = serviceForGoogle(googleOperations(calls, observed));
    const clientContext = { directory: "/workspace", worktree: "/workspace/tree" };

    for (const descriptor of GOOGLE_WORKSPACE_EXTENSION_ACTIONS) {
      await service.call({
        extensionId: descriptor.extensionId,
        action: descriptor.action,
        args: {},
        context: clientContext,
      }, { connectSnapshot: ungatedSnapshot });
    }

    expect(calls).toEqual(GOOGLE_WORKSPACE_EXTENSION_ACTIONS.map((item) => item.action));
    expect(observed.draftContext).toEqual(clientContext);
  });

  test("hides only gated non-status actions while direct calls return the legacy HTTP-200 body", async () => {
    const calls: string[] = [];
    const observed: { statusExtra?: Record<string, unknown>; draftContext?: Record<string, unknown> } = {};
    const service = serviceForGoogle(googleOperations(calls, observed));

    expect(service.list("google-workspace", { connectSnapshot: gatedSnapshot }).map((item) => item.action)).toEqual(["status"]);
    expect(await service.call({
      extensionId: "google-workspace",
      action: "calendar_list_events",
      args: {},
      context: {},
    }, { connectSnapshot: gatedSnapshot })).toEqual({
      ok: false,
      error: "use_openwork_cloud",
      message: "Connect guidance (true)",
    });
    expect(calls).toEqual([]);

    await service.call({ extensionId: "google-workspace", action: "status" }, { connectSnapshot: gatedSnapshot });
    expect(observed.statusExtra).toEqual({ connect: { enabled: true, cloudMcpPresent: true } });
  });
});

describe("OpenAI image generation action contributions", () => {
  test("keep both descriptors ordered and preserve the top-level generated path", async () => {
    expect(OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS.map((item) => item.action)).toEqual(["status", "image_generate"]);
    const contributions = createOpenAiImageGenerationActionContributions({
      status: async () => ({ configured: true }),
      generate: async () => ({
        path: "artifacts/generated.png",
        bytes: 42,
        model: "gpt-image-2",
        workspaceId: "ws_1",
      }),
    });
    const service = createExtensionActionService({
      list: () => [...contributions],
      lookup: (extensionId, action) => contributions.find((item) => (
        item.descriptor.extensionId === extensionId && item.descriptor.action === action
      )),
    });

    expect(await service.call({
      extensionId: "openai-image-generation",
      action: "image_generate",
      args: { prompt: "A quiet lake" },
      context: { directory: "/workspace" },
    })).toEqual({
      ok: true,
      extensionId: "openai-image-generation",
      action: "image_generate",
      path: "artifacts/generated.png",
      result: {
        path: "artifacts/generated.png",
        bytes: 42,
        model: "gpt-image-2",
        workspaceId: "ws_1",
      },
      context: { directory: "/workspace" },
    });
  });
});
