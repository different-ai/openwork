import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { snapshotFailure } from "../worlds/chat.ts";

const test = spec.world(snapshotFailure);

test("the composer stays editable while the session snapshot query is in error", async ({ user, agent, step }) => {
  const text = "Draft survives the broken snapshot without being sent — composer proof 9472.";
  const transcriptLiteral = "chat-transcript-proof";

  await step("the composer remains editable after the snapshot fails", async () => {
    await user.see("composer", { editable: true, timeoutMs: 30_000 });
  });

  await step("a distinctive draft can be typed and remains editable", async () => {
    await user.type("composer", text);
    await user.see("composer", { editable: true, text, timeoutMs: 30_000 });
  });

  await step("typing does not send and the cached transcript remains visible", async () => {
    const transcript = await agent.run("session.read_transcript", { count: 30 });
    const readableTranscript = JSON.stringify(transcript);
    expect(readableTranscript).not.toContain(text);
    expect(readableTranscript).toContain(transcriptLiteral);
    await user.see({ text: /chat-transcript-proof/ }, { timeoutMs: 30_000 });
  });
});
