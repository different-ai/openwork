import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ATTACHED_PDF, MOCK_REPLY, ON_DISK_PDF, READ_SCENARIO_MARKER, pdfRouting } from "../worlds/pdf-attachments.ts";
import type { PdfRoutingModel } from "../worlds/pdf-attachments.ts";

// A PDF attached in chat must work with every model the engine can run. This
// spec drives the real openwork-server and its managed OpenCode engine, with
// the shipped plugin set, against a mock provider that records what each model
// actually received. The user-visible claims:
//   - a PDF-capable model still gets the PDF itself;
//   - an image-capable model gets rendered page images plus page-marked text;
//   - a text-only model gets the text and an honest note about unreadable pages;
//   - a PDF the agent reads from disk is routed the same way;
//   - the persisted transcript keeps the original PDF part in every case.

const test = spec.world(pdfRouting, { needs: { commands: ["bun"] }, timeout: 240_000 });

const models: readonly PdfRoutingModel[] = ["vision", "text", "native"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partsOf(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message) || !Array.isArray(message.parts)) throw new Error("Expected message parts");
  return message.parts.filter(isRecord);
}

function replyText(result: unknown): string {
  return isRecord(result) && Array.isArray(result.parts)
    ? result.parts.filter(isRecord).filter((part) => part.type === "text").map((part) => String(part.text)).join("")
    : "";
}

function sessionIdOf(session: unknown): string {
  const id = isRecord(session) && typeof session.id === "string" ? session.id : "";
  expect(id).not.toBe("");
  return id;
}

test("each model receives an attached PDF in the form it can take, and the transcript keeps the PDF", { timeout: 200_000 }, async ({ world, step, evidence }) => {
  const observed: Partial<Record<PdfRoutingModel, { provider: string[]; persisted: string[]; reply: string }>> = {};
  for (const modelID of models) {
    await step(`attach ${ATTACHED_PDF} for the ${modelID} model`, async () => {
      const sessionId = sessionIdOf(await world.engine("POST", "/session", { title: `pdf ${modelID}` }));
      const before = world.requests.length;
      const result = await world.engine("POST", `/session/${sessionId}/message`, {
        model: { providerID: "mock", modelID },
        parts: [world.attachment, { type: "text", text: "Summarize this." }],
      });
      const transcript = await world.engine("GET", `/session/${sessionId}/message`);
      const user = Array.isArray(transcript) ? transcript.filter(isRecord).find((message) => isRecord(message.info) && message.info.role === "user") : undefined;
      observed[modelID] = {
        provider: world.requests.slice(before).flatMap((request) => request.parts),
        persisted: partsOf(user).map((part) => (part.type === "file" ? `file:${String(part.mime)}` : String(part.type))),
        reply: replyText(result),
      };
    });
  }

  const read = await step(`a text-only model reads ${ON_DISK_PDF} from disk through the Read tool`, async () => {
    const sessionId = sessionIdOf(await world.engine("POST", "/session", { title: "pdf read on disk" }));
    const before = world.requests.length;
    const result = await world.engine("POST", `/session/${sessionId}/message`, {
      model: { providerID: "mock", modelID: "text" },
      parts: [{ type: "text", text: READ_SCENARIO_MARKER }],
    });
    const transcript = await world.engine("GET", `/session/${sessionId}/message`);
    const toolPart = Array.isArray(transcript)
      ? transcript.filter(isRecord).flatMap((message) => partsOf(message)).find((part) => part.type === "tool")
      : undefined;
    const state = toolPart && isRecord(toolPart.state) ? toolPart.state : null;
    return {
      requests: world.requests.slice(before),
      reply: replyText(result),
      persistedAttachments: Array.isArray(state?.attachments) ? state.attachments.map((attachment) => (isRecord(attachment) ? attachment.mime : "?")) : [],
    };
  });

  expect(observed.vision?.provider).toEqual(["image_url:data:image/png", "image_url:data:image/png", "image_url:data:image/png", "text:note", "text:Summarize this."]);
  expect(observed.text?.provider).toEqual(["text:note", "text:Summarize this."]);
  expect(observed.native?.provider).toEqual([`file:${ATTACHED_PDF}`, "text:Summarize this."]);
  for (const modelID of models) {
    expect(observed[modelID]?.reply, modelID).toBe(MOCK_REPLY);
    expect(observed[modelID]?.persisted, modelID).toEqual(["file:application/pdf", "text"]);
  }
  evidence.recordAssertionEvidence(
    "Inside the real engine, an image-capable model received page images plus text, a text-only model received text, and a PDF-capable model received the PDF itself",
    `OpenCode ${world.engineVersion} behind openwork-server with its shipped plugins; the provider saw vision=${observed.vision?.provider.join(",")} text=${observed.text?.provider.join(",")} native=${observed.native?.provider.join(",")}; every reply completed and every persisted user message kept its application/pdf part.`,
    true,
  );

  expect(read.requests.length).toBe(2);
  expect(read.requests[1].toolResults).toEqual(["tool:note"]);
  expect(read.requests[1].parts.some((part) => part.startsWith("file:") || part.startsWith("image_url:"))).toBe(false);
  expect(read.reply).toBe(MOCK_REPLY);
  expect(read.persistedAttachments).toEqual(["application/pdf"]);
  expect(world.requests.every((request) => request.tools.includes("openwork_pdf_pages"))).toBe(true);
  evidence.recordAssertionEvidence(
    "A text-only model that reads a PDF from disk through the Read tool receives its text instead of a PDF it cannot take, and the persisted tool result keeps the original attachment",
    `The mock model asked the engine to read ${ON_DISK_PDF}; the follow-up request carried one tool result containing the OpenWork PDF note and no file or image parts, the turn completed, and the transcript's tool part still holds an application/pdf attachment. Every request advertised the openwork_pdf_pages tool.`,
    true,
  );

  const derived = await world.derivedBundles();
  expect(derived).toHaveLength(2);
  expect(derived.some((name) => name.endsWith("-report"))).toBe(true);
  expect(derived.some((name) => name.endsWith("-on-disk"))).toBe(true);
  evidence.recordAssertionEvidence(
    "Derived text and page images are kept in the workspace inbox for the agent's tools and later steps",
    `.opencode/openwork/inbox/pdf-pages holds ${derived.join(" and ")}.`,
    true,
  );
});
