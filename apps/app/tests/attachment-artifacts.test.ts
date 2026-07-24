import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { canOpenArtifact, getArtifactsFromMessages } from "../src/lib/artifacts";
import { deriveOpenTargets, filePathFromFileUrl, type OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";

const ATTACHMENT_URL = "file:///workspaces/Worker%20Root/.opencode/openwork/inbox/chat-attachments/ses_1/nonce-pge_natural_gas_billing_billing_data_service%202_2_2025-02-20_to_2025-12-05.csv";
const ATTACHMENT_PATH = "/workspaces/Worker Root/.opencode/openwork/inbox/chat-attachments/ses_1/nonce-pge_natural_gas_billing_billing_data_service 2_2_2025-02-20_to_2025-12-05.csv";

function userMessageWithAttachment(): UIMessage {
  return {
    id: "msg_1",
    role: "user",
    parts: [
      { type: "text", text: "what do you make of these bills?" },
      {
        type: "file",
        mediaType: "text/plain",
        filename: "pge_natural_gas_billing_billing_data_service 2_2_2025-02-20_to_2025-12-05.csv",
        url: ATTACHMENT_URL,
      },
    ],
  };
}

describe("attachment artifacts", () => {
  test("filePathFromFileUrl decodes workspace file URLs and rejects other schemes", () => {
    expect(filePathFromFileUrl(ATTACHMENT_URL)).toBe(ATTACHMENT_PATH);
    expect(filePathFromFileUrl("file:///C:/Users/Ada/%E5%B7%A5%E4%BD%9C/scan.pdf")).toBe("C:/Users/Ada/工作/scan.pdf");
    expect(filePathFromFileUrl("data:text/plain;base64,aGk=")).toBeNull();
    expect(filePathFromFileUrl("https://example.com/file.csv")).toBeNull();
  });

  test("deriveOpenTargets surfaces user attachment file parts, spaces included", () => {
    const targets = deriveOpenTargets([userMessageWithAttachment()]);
    const attachment = targets.find((target) => target.reason === "chat attachment");

    expect(attachment).toMatchObject({
      kind: "file",
      value: ATTACHMENT_PATH,
      name: "pge_natural_gas_billing_billing_data_service 2_2_2025-02-20_to_2025-12-05.csv",
      preview: "sheet",
      confidence: 95,
    });
  });

  test("attachment artifacts become clickable once the server verifies they exist", () => {
    const message = userMessageWithAttachment();
    const derived = deriveOpenTargets([message]);
    const verified: OpenTarget[] = derived.map((target) => ({ ...target, exists: true }));

    const artifacts = getArtifactsFromMessages([message], verified);
    const attachment = artifacts.find((artifact) => artifact.legacy_target.reason === "chat attachment");

    expect(attachment).toBeDefined();
    expect(attachment && canOpenArtifact(attachment)).toBe(true);
  });
});
