import { describe, expect, test } from "bun:test";
import {
  clipboardAttachmentFiles,
  MIN_CLIPBOARD_ATTACHMENT_BYTES,
} from "../src/react-app/domains/session/surface/composer/clipboard-files";

function fileWithSize(size: number, name: string) {
  return new File([new Uint8Array(size)], name);
}

describe("clipboard attachment files", () => {
  test("ignores clipboard files below the automatic attachment threshold", () => {
    const tiny = fileWithSize(MIN_CLIPBOARD_ATTACHMENT_BYTES - 1, "tiny.png");

    expect(clipboardAttachmentFiles([tiny])).toEqual([]);
  });

  test("keeps clipboard files at or above the automatic attachment threshold", () => {
    const minimum = fileWithSize(MIN_CLIPBOARD_ATTACHMENT_BYTES, "minimum.png");
    const larger = fileWithSize(MIN_CLIPBOARD_ATTACHMENT_BYTES + 1, "larger.png");

    expect(clipboardAttachmentFiles([minimum, larger])).toEqual([minimum, larger]);
  });

  test("keeps eligible files when a clipboard paste contains mixed sizes", () => {
    const tiny = fileWithSize(1, "tiny.txt");
    const eligible = fileWithSize(MIN_CLIPBOARD_ATTACHMENT_BYTES, "eligible.txt");

    expect(clipboardAttachmentFiles([tiny, eligible])).toEqual([eligible]);
  });
});
