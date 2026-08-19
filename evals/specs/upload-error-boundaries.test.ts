import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { safeAttachmentFilename } from "../../apps/app/src/react-app/domains/session/sync/attachment-file-part";
import { normalizeWorkspaceRelativePath } from "../../apps/server/src/routes/files";

const encoder = new TextEncoder();

test("upload filename and path boundaries reject unsafe writes", ({ evidence }) => {
  const asciiInput = `${"a".repeat(400)}.pdf`;
  const multibyteInput = `${"李".repeat(200)}.txt`;
  const asciiName = safeAttachmentFilename(asciiInput);
  const multibyteName = safeAttachmentFilename(multibyteInput);

  expect(encoder.encode(asciiInput).byteLength).toBeGreaterThan(255);
  expect(encoder.encode(multibyteInput).byteLength).toBeGreaterThan(255);
  expect(encoder.encode(asciiName).byteLength).toBeLessThanOrEqual(255);
  expect(encoder.encode(multibyteName).byteLength).toBeLessThanOrEqual(255);
  expect(asciiName.endsWith(".pdf")).toBe(true);
  expect(multibyteName.endsWith(".txt")).toBe(true);
  expect(asciiName).not.toBe(asciiInput);
  expect(multibyteName).not.toBe(multibyteInput);
  expect(multibyteName).not.toContain("�");

  evidence.recordAssertionEvidence(
    "Oversized ASCII and multibyte upload names are bounded with extensions preserved",
    `The ${encoder.encode(asciiInput).byteLength}-byte ASCII and ${encoder.encode(multibyteInput).byteLength}-byte multibyte inputs became ${encoder.encode(asciiName).byteLength}-byte .pdf and ${encoder.encode(multibyteName).byteLength}-byte .txt names without a broken UTF-8 character.`,
    true,
  );
  const unsafePaths = [
    ["reports/CON.txt", "Windows reserved device names"],
    ["reports/screenshot.png:metadata", "must not contain colons"],
    ["reports/screenshot.png.", "must not end with a dot or space"],
    ["reports/screenshot.png ", "must not end with a dot or space"],
  ] as const;

  for (const [path, message] of unsafePaths) {
    expect(() => normalizeWorkspaceRelativePath(path, { allowSubdirs: true })).toThrow(message);
  }

  for (const segment of ["a".repeat(256), "李".repeat(86)]) {
    expect(encoder.encode(segment).byteLength).toBeGreaterThan(255);
    expect(() => normalizeWorkspaceRelativePath(`reports/${segment}`, { allowSubdirs: true }))
      .toThrow("Path components must not exceed 255 UTF-8 bytes");
  }

  const boundaryName = `${"a".repeat(251)}.txt`;
  expect(encoder.encode(boundaryName).byteLength).toBe(255);
  expect(normalizeWorkspaceRelativePath(`reports/${boundaryName}`, { allowSubdirs: true }))
    .toBe(`reports/${boundaryName}`);
  expect(normalizeWorkspaceRelativePath("reports/console.txt", { allowSubdirs: true }))
    .toBe("reports/console.txt");

  evidence.recordAssertionEvidence(
    "Windows-unsafe and oversized upload path components are rejected at the server boundary",
    "Reserved-device, alternate-data-stream, trailing-dot, trailing-space, 256-byte ASCII, and 258-byte multibyte components all threw their expected invalid-path messages; an exact 255-byte filename and an ordinary lookalike remained valid.",
    true,
  );
});
