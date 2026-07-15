export const MIN_CLIPBOARD_ATTACHMENT_BYTES = 10 * 1024;

export function clipboardAttachmentFiles(files: readonly File[]) {
  return files.filter((file) => file.size >= MIN_CLIPBOARD_ATTACHMENT_BYTES);
}
