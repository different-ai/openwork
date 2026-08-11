import { describe, expect, test } from "bun:test";

import {
  buildFileInputExtensionCall,
  OPENWORK_CLOUD_EXECUTE_CAPABILITY_TOOL,
  readFileInputDescriptor,
  repairFileInputToolResult,
} from "./openwork-extensions-preview-file-inputs.js";

const descriptor = {
  field: "attachments",
  extensionId: "openwork-cloud-uploads",
  action: "gmail_create_draft_with_attachments",
  argsField: "paths",
};

function hostRequiredResult() {
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "file_input_requires_host",
        message: "attachments lists workspace file paths whose bytes are uploaded by the OpenWork host.",
        fileInput: descriptor,
      }),
    }],
  };
}

function draftArgs() {
  return {
    name: "postCapabilitiesGoogleWorkspaceGmailDrafts",
    body: {
      to: "ben@openworklabs.com",
      subject: "Sentry report",
      body: "Attached.",
      attachments: ["reports/sentry-unresolved-issues.md"],
    },
  };
}

describe("readFileInputDescriptor", () => {
  test("reads the descriptor from a file_input_requires_host text payload", () => {
    expect(readFileInputDescriptor(hostRequiredResult())).toEqual(descriptor);
  });

  test("ignores ordinary results and other errors", () => {
    expect(readFileInputDescriptor({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] })).toBeNull();
    expect(readFileInputDescriptor({ content: [{ type: "text", text: JSON.stringify({ error: "needs_connection" }) }] })).toBeNull();
    expect(readFileInputDescriptor({ content: [{ type: "text", text: "not json" }] })).toBeNull();
    expect(readFileInputDescriptor(null)).toBeNull();
  });

  test("rejects descriptors with missing fields", () => {
    const result = hostRequiredResult();
    result.content[0] = {
      type: "text",
      text: JSON.stringify({ error: "file_input_requires_host", fileInput: { field: "attachments" } }),
    };
    expect(readFileInputDescriptor(result)).toBeNull();
  });
});

describe("buildFileInputExtensionCall", () => {
  test("maps the capability body onto the extension action args", () => {
    expect(buildFileInputExtensionCall(draftArgs(), descriptor)).toEqual({
      extensionId: "openwork-cloud-uploads",
      action: "gmail_create_draft_with_attachments",
      args: {
        to: "ben@openworklabs.com",
        subject: "Sentry report",
        body: "Attached.",
        paths: ["reports/sentry-unresolved-issues.md"],
      },
    });
  });

  test("returns null without a non-empty string path array", () => {
    expect(buildFileInputExtensionCall({ name: "x", body: { to: "a@b.c", attachments: [] } }, descriptor)).toBeNull();
    expect(buildFileInputExtensionCall({ name: "x", body: { to: "a@b.c", attachments: [7] } }, descriptor)).toBeNull();
    expect(buildFileInputExtensionCall({ name: "x", body: { to: "a@b.c" } }, descriptor)).toBeNull();
    expect(buildFileInputExtensionCall({ name: "x" }, descriptor)).toBeNull();
  });
});

describe("repairFileInputToolResult", () => {
  test("re-runs the request through the local action and rewrites the result", async () => {
    const result = hostRequiredResult();
    const calls: unknown[] = [];
    const repaired = await repairFileInputToolResult({
      tool: OPENWORK_CLOUD_EXECUTE_CAPABILITY_TOOL,
      args: draftArgs(),
      result,
      callExtensionAction: async (call) => {
        calls.push(call);
        return { ok: true, draftId: "d1", draftUrl: "https://mail.google.com/#drafts?compose=d1" };
      },
    });
    expect(repaired).toBe(true);
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(false);
    const first = result.content[0];
    if (!first) throw new Error("missing rewritten content");
    expect(JSON.parse(first.text)).toEqual({
      ok: true,
      draftId: "d1",
      draftUrl: "https://mail.google.com/#drafts?compose=d1",
    });
  });

  test("surfaces upload failures as a structured error result", async () => {
    const result = hostRequiredResult();
    const repaired = await repairFileInputToolResult({
      tool: OPENWORK_CLOUD_EXECUTE_CAPABILITY_TOOL,
      args: draftArgs(),
      result,
      callExtensionAction: async () => {
        throw new Error("File was not found inside an authorized workspace root.");
      },
    });
    expect(repaired).toBe(true);
    expect(result.isError).toBe(true);
    const first = result.content[0];
    if (!first) throw new Error("missing rewritten content");
    expect(JSON.parse(first.text)).toEqual({
      error: "file_input_upload_failed",
      message: "File was not found inside an authorized workspace root.",
      fileInput: descriptor,
    });
  });

  test("leaves other tools and other results untouched", async () => {
    const untouched = hostRequiredResult();
    const before = JSON.stringify(untouched);
    expect(await repairFileInputToolResult({
      tool: "some-other-tool",
      args: draftArgs(),
      result: untouched,
      callExtensionAction: async () => ({ ok: true }),
    })).toBe(false);
    expect(JSON.stringify(untouched)).toBe(before);

    const okResult = { content: [{ type: "text", text: JSON.stringify({ ok: true, draftId: "d2" }) }] };
    expect(await repairFileInputToolResult({
      tool: OPENWORK_CLOUD_EXECUTE_CAPABILITY_TOOL,
      args: draftArgs(),
      result: okResult,
      callExtensionAction: async () => ({ ok: true }),
    })).toBe(false);
  });

  test("keeps the cloud error visible when args carry no usable paths", async () => {
    const result = hostRequiredResult();
    const before = JSON.stringify(result);
    expect(await repairFileInputToolResult({
      tool: OPENWORK_CLOUD_EXECUTE_CAPABILITY_TOOL,
      args: { name: "postCapabilitiesGoogleWorkspaceGmailDrafts", body: { to: "a@b.c", attachments: [] } },
      result,
      callExtensionAction: async () => ({ ok: true }),
    })).toBe(false);
    expect(JSON.stringify(result)).toBe(before);
  });
});
