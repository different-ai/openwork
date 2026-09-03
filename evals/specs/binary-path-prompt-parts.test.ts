import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { draftToParts } from "../../apps/app/src/react-app/domains/session/sync/draft-parts";
import { firstLineLocalFileParts } from "../../apps/app/src/react-app/domains/session/sync/prompt-file-parts";

// opencode expands every `text/plain` `file://` part through the Read tool
// before the model sees the prompt. Read inlines text and attaches images and
// PDFs, but refuses other binaries with "Cannot read binary file", which the
// engine publishes as a session error. A typed or mentioned path to such a
// file must therefore reach the model as plain text, never as a file part.

test("a typed binary media path is not attached as a text/plain file part", () => {
  const parts = firstLineLocalFileParts(
    "could you add this to descript /Users/ben/Downloads/C0217.MP4",
    "/Users/ben/code/openwork",
  );

  expect(parts).toEqual([]);
});

test("a typed text path in the same position is still attached", () => {
  const parts = firstLineLocalFileParts(
    "could you summarize this /Users/ben/Downloads/notes.md",
    "/Users/ben/code/openwork",
  );

  expect(parts).toEqual([{
    type: "file",
    mime: "text/plain",
    url: "file:///Users/ben/Downloads/notes.md",
    filename: "notes.md",
  }]);
});

test("a binary @file mention keeps its path as text while a text mention stays a file part", async () => {
  const parts = await draftToParts(
    {
      mode: "prompt",
      text: "add @/Users/ben/Downloads/C0217.MP4 to descript and read @notes.md",
      parts: [
        { type: "file", path: "/Users/ben/Downloads/C0217.MP4" },
        { type: "file", path: "notes.md" },
      ],
      attachments: [],
    },
    "/Users/ben/code",
    "ses_binary_path",
    null,
  );

  expect(parts.filter((part) => part.type === "file")).toEqual([
    { type: "file", mime: "text/plain", url: "file:///Users/ben/code/notes.md", filename: "notes.md" },
  ]);
  expect(parts).toContainEqual({ type: "text", text: "/Users/ben/Downloads/C0217.MP4" });
});
