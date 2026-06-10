/**
 * Which attachment media types can be sent to the model as file parts.
 *
 * Providers (via opencode + the AI SDK) accept images, PDFs, and text.
 * Anything else (e.g. Keynote `application/x-iwork-keynote-sffkey`, Office
 * binaries) is rejected by the provider with an UnsupportedFunctionalityError
 * — and because the file part lives in server-side session history, every
 * later message in the session replays the failure. Blocking these at attach
 * time prevents poisoning the session.
 *
 * Empty / `application/octet-stream` types are allowed: browsers report them
 * for plain source/code files, which are sent as `text/plain`.
 */
export function isModelReadableAttachment(mimeType: string) {
  const mime = mimeType.toLowerCase();
  if (mime === "" || mime === "application/octet-stream") return true;
  if (mime.startsWith("image/") || mime.startsWith("text/")) return true;
  if (mime === "application/pdf" || mime === "application/json") return true;
  return mime.endsWith("+json") || mime.endsWith("+xml") || mime === "application/xml" || mime === "application/javascript";
}
