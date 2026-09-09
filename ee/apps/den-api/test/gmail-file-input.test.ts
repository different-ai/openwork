import { expect, test } from "bun:test"
import { gmailFileInputPreflight, gmailFileInputPreflightSchema } from "../src/capability-sources/gmail-file-input.js"

test("Gmail host preflight accepts only the exact no-draft marker without a dispatch descriptor", () => {
  expect(gmailFileInputPreflightSchema.parse(gmailFileInputPreflight)).toEqual({
    ok: false,
    error: "file_input_requires_host",
    created: false,
    message: "Workspace attachments require a supporting OpenWork host. No draft was created. Do not retry without attachments.",
  })
  for (const value of [
    null,
    { ...gmailFileInputPreflight, ok: true },
    { ...gmailFileInputPreflight, created: true },
    { ...gmailFileInputPreflight, created: undefined },
    { ...gmailFileInputPreflight, error: "google_api_error" },
    { ...gmailFileInputPreflight, message: "Retry without attachments" },
    { ...gmailFileInputPreflight, extensionId: "another-extension" },
    { ...gmailFileInputPreflight, field: "attachments", action: "another-action" },
  ]) {
    expect(gmailFileInputPreflightSchema.safeParse(value).success).toBe(false)
  }
})
