import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { plainFeedbackFieldSchemas } from "../lib/plain-feedback-fields";
import { setupPlainFeedbackFields } from "../scripts/setup-plain-feedback-fields.mjs";

const log = spyOn(console, "log").mockImplementation(() => {});
afterAll(() => log.mockRestore());

function schemaPage(fields: { key: string; type: string; order: number }[], endCursor: string | null = null) {
  return { threadFieldSchemas: {
    edges: fields.map((node) => ({ node })),
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
  } };
}

function requestMock() {
  return mock(async (_document: unknown, _variables: Record<string, unknown>): Promise<unknown> => {
    throw new Error("Unexpected Plain API call");
  });
}

describe("Plain feedback field setup", () => {
  test("reads all pages, preserves existing schemas, and creates only missing fields", async () => {
    const request = requestMock()
      .mockResolvedValueOnce(schemaPage(plainFeedbackFieldSchemas.slice(0, 2), "page-2"))
      .mockResolvedValueOnce(schemaPage([
        ...plainFeedbackFieldSchemas.slice(2, -1),
        { key: "existing_field", type: "STRING", order: 100 },
      ]))
      .mockResolvedValueOnce({ createThreadFieldSchema: { threadFieldSchema: { key: "openwork_metadata" }, error: null } });

    await setupPlainFeedbackFields({ request });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][1]).toEqual({ after: "page-2" });
    expect(request.mock.calls[2][1]).toMatchObject({ input: {
      key: "openwork_metadata", type: "STRING", order: 101,
      isRequired: false, isClientReadonly: true, isAiAutoFillEnabled: false, isAvailableToAgents: false,
    } });
  });

  test("is a no-op when the workspace is already configured", async () => {
    const request = requestMock().mockResolvedValueOnce(schemaPage(plainFeedbackFieldSchemas));
    await setupPlainFeedbackFields({ request });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("stops before creating anything when an existing key has the wrong type", async () => {
    const request = requestMock().mockResolvedValueOnce(schemaPage([
      { key: "openwork_os_name", type: "NUMBER", order: 0 },
    ]));
    await expect(setupPlainFeedbackFields({ request })).rejects.toThrow("openwork_os_name must have type STRING");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("reports a partial setup failure so reruns can skip completed fields", async () => {
    const request = requestMock()
      .mockResolvedValueOnce(schemaPage([]))
      .mockResolvedValueOnce({ createThreadFieldSchema: { threadFieldSchema: { key: "openwork_os_name" }, error: null } })
      .mockResolvedValueOnce({ createThreadFieldSchema: { error: { code: "forbidden" } } });
    await expect(setupPlainFeedbackFields({ request })).rejects.toThrow("Could not create openwork_app_version: forbidden");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
