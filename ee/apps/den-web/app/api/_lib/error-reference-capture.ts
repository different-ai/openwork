import { denErrorReferenceId } from "@openwork/types/den/error-reference";

export function createErrorReferenceCapture() {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  return {
    append(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (bytes <= 8_192) text += decoder.decode(chunk, { stream: true });
      else text = "";
    },
    referenceId() {
      if (bytes > 8_192) return undefined;
      try {
        const payload: unknown = JSON.parse(text + decoder.decode());
        return denErrorReferenceId(payload);
      } catch {
        return undefined;
      }
    },
  };
}
