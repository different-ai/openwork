declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: string) => void;
};

import {
  describeProviderTransportError,
  presentOpencodeSessionError,
} from "./session-error";

const reportedError = "Cannot connect to API: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const friendlyError = "Couldn't reach the AI provider. Check your internet connection and try again.";

describe("provider transport error presentation", () => {
  test("maps the reported transport error and retains its diagnostic text", () => {
    const presentation = presentOpencodeSessionError(reportedError);

    expect(presentation.title).toBe(friendlyError);
    expect(presentation.technicalDetails).toContain(reportedError);
  });

  test("does not map rate-limit or authentication errors", () => {
    const rateLimitError = "429 Too Many Requests: rate limit exceeded";
    const authError = "401 Unauthorized: invalid API key";

    expect(describeProviderTransportError(rateLimitError)).toBe(rateLimitError);
    expect(describeProviderTransportError(authError)).toBe(authError);
  });

  test("passes empty and unknown errors through unchanged", () => {
    const unknownError = "The model returned malformed JSON";

    expect(describeProviderTransportError("")).toBe("");
    expect(describeProviderTransportError(unknownError)).toBe(unknownError);
  });
});
