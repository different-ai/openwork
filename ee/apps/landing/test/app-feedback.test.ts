import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ForbiddenError, PlainClient } from "@team-plain/graphql";
import { parse, visit } from "graphql";

const checkBotId = mock(async () => ({ isBot: false }));
mock.module("botid/server", () => ({ checkBotId }));

const { POST } = await import("../app/api/app-feedback/route");
const originalApiKey = process.env.PLAIN_API_KEY;
const originalFetch = globalThis.fetch;
const fetchMock = spyOn(globalThis, "fetch");
const errorLog = spyOn(console, "error").mockImplementation(() => {});
const requests: { url: unknown; options: RequestInit | undefined; body: unknown }[] = [];
let responses: Response[] = [];
let requestNumber = 0;
let restrictRelatedResourceReads = false;

function formRequest(overrides: Record<string, unknown> = {}, origin = "https://openworklabs.com") {
  return new Request("https://openworklabs.com/api/app-feedback", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-forwarded-for": `test-${++requestNumber}`,
    },
    body: JSON.stringify({
      name: " Test User ",
      email: " test@example.com ",
      message: " Please help with this issue. ",
      startedAt: Date.now() - 5000,
      website: "",
      ...overrides,
    }),
  });
}

function submittedMetadata(): unknown {
  const body = requests[1].body;
  if (!body || typeof body !== "object" || !("variables" in body)) throw new Error("Missing variables");
  const variables = body.variables;
  if (!variables || typeof variables !== "object" || !("input" in variables)) throw new Error("Missing input");
  const input = variables.input;
  if (!input || typeof input !== "object" || !("threadFields" in input) || !Array.isArray(input.threadFields)) {
    throw new Error("Missing thread fields");
  }
  const metadata: unknown = input.threadFields.find((field: unknown) =>
    field && typeof field === "object" && "key" in field && field.key === "openwork_metadata");
  if (!metadata || typeof metadata !== "object" || !("stringValue" in metadata) || typeof metadata.stringValue !== "string") {
    throw new Error("Missing metadata");
  }
  return JSON.parse(metadata.stringValue);
}

function customerResponse(result = "CREATED") {
  return Response.json({ data: { upsertCustomer: { result, customer: { id: "c_test" }, error: null } } });
}

beforeEach(() => {
  process.env.PLAIN_API_KEY = "plainApiKey_test";
  requests.length = 0;
  responses = [customerResponse(), Response.json({ data: { createThread: { thread: { id: "t_test" }, error: null } } })];
  checkBotId.mockResolvedValue({ isBot: false });
  errorLog.mockClear();
  restrictRelatedResourceReads = false;
  fetchMock.mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const body: unknown = typeof options?.body === "string" ? JSON.parse(options.body) : null;
    requests.push({
      url,
      options,
      body,
    });
    if (restrictRelatedResourceReads && body && typeof body === "object" && "query" in body && typeof body.query === "string") {
      let readsRelatedResource = false;
      visit(parse(body.query), {
        Field(node) {
          if (["company", "user", "machineUser", "workflow", "tenant", "assignedTo", "labels", "threadFields"].includes(node.name.value)) {
            readsRelatedResource = true;
          }
        },
      });
      if (readsRelatedResource) {
        return Response.json({ errors: [{ message: "Insufficient permissions to read related resources" }] }, { status: 403 });
      }
    }
    const response = responses.shift();
    if (!response) throw new Error("Unexpected API call");
    return response;
  }, { preconnect: originalFetch.preconnect }));
});

afterAll(() => {
  fetchMock.mockRestore();
  errorLog.mockRestore();
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.PLAIN_API_KEY;
  else process.env.PLAIN_API_KEY = originalApiKey;
});

describe("contact and feedback submissions to Plain", () => {
  test("submits with form-only scopes when generated SDK mutations are forbidden", async () => {
    restrictRelatedResourceReads = true;
    const generatedClient = new PlainClient({ apiKey: "plainApiKey_test" });
    await expect(generatedClient.mutation.upsertCustomer({ input: {
      identifier: { emailAddress: "test@example.com" },
      onCreate: { fullName: "Test User", email: { email: "test@example.com", isVerified: false } },
      onUpdate: {},
    } })).rejects.toBeInstanceOf(ForbiddenError);

    const response = await POST(formRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toHaveLength(3);
    expect(responses).toHaveLength(0);
  });

  for (const mode of ["contact", "feedback"]) {
    test(`${mode} creates a customer and thread with the submitted context`, async () => {
      const response = await POST(formRequest({
        mode,
        context: {
          source: "openwork-app",
          entrypoint: "/settings",
          deployment: "desktop",
          appVersion: "1.0.0",
          openworkServerVersion: "1.1.0",
          opencodeVersion: "1.2.0",
          osName: "macOS",
          osVersion: "15",
          platform: "darwin",
        },
      }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe("https://core-api.uk.plain.com/graphql/v1");
        expect(request.options).toMatchObject({ method: "POST", headers: { Authorization: "Bearer plainApiKey_test" } });
      }
      expect(requests[0].body).toMatchObject({ variables: { input: {
        identifier: { emailAddress: "test@example.com" },
        onCreate: { fullName: "Test User", email: { email: "test@example.com", isVerified: false } },
        onUpdate: {},
      } } });
      const metadata = submittedMetadata();
      expect(requests[1].body).toMatchObject({ variables: { input: {
        customerIdentifier: { customerId: "c_test" },
        title: mode === "contact" ? "OpenWork contact message" : "OpenWork app feedback",
        threadFields: [
          { key: "openwork_os_name", type: "STRING", stringValue: "macOS" },
          { key: "openwork_app_version", type: "STRING", stringValue: "1.0.0" },
          { key: "openwork_deployment", type: "STRING", stringValue: "desktop" },
          { key: "openwork_metadata", type: "STRING", stringValue: expect.any(String) },
        ],
        components: [{ componentPlainText: { plainText: "Please help with this issue." } }],
      } } });
      expect(metadata).toEqual({
        name: "Test User", email: "test@example.com", mode,
        source: "openwork-app", entrypoint: "/settings", openworkServerVersion: "1.1.0",
        opencodeVersion: "1.2.0", osVersion: "15", platform: "darwin",
        submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });
  }

  test("reuses an existing customer without changing their profile", async () => {
    responses[0] = customerResponse("NOOP");
    expect((await POST(formRequest())).status).toBe(200);
    expect(requests[0].body).toMatchObject({ variables: { input: { onUpdate: {} } } });
    expect(requests[1].body).toMatchObject({ variables: { input: { customerIdentifier: { customerId: "c_test" } } } });
  });

  test("omits unavailable desktop fields for a web contact submission", async () => {
    const response = await POST(formRequest({ mode: "contact", context: {
      source: "openwork-contact-page", entrypoint: "/contact", deployment: "landing", platform: "web",
      appVersion: "", openworkServerVersion: "unknown", osName: "  ", osVersion: null,
    } }));
    expect(response.status).toBe(200);
    const metadata = submittedMetadata();
    expect(requests[1].body).toMatchObject({ variables: { input: { threadFields: [
      { key: "openwork_deployment", type: "STRING", stringValue: "landing" },
      { key: "openwork_metadata", type: "STRING", stringValue: expect.any(String) },
    ] } } });
    expect(metadata).toEqual({
      name: "Test User", email: "test@example.com", mode: "contact",
      source: "openwork-contact-page", entrypoint: "/contact", platform: "web",
      submittedAt: expect.any(String),
    });
  });

  test("preserves version strings and only writes allowlisted, sanitized context", async () => {
    const response = await POST(formRequest({ context: {
      appVersion: " 1.2.3-beta.4+build.5 ", osVersion: " 10/11 ",
      source: "s".repeat(300), platform: 123,
      openwork_form_mode: "override", arbitrary_field: "ignore",
    } }));
    expect(response.status).toBe(200);
    const metadata = submittedMetadata();
    expect(requests[1].body).toMatchObject({ variables: { input: { threadFields: [
      { key: "openwork_app_version", type: "STRING", stringValue: "1.2.3-beta.4+build.5" },
      { key: "openwork_metadata", type: "STRING", stringValue: expect.any(String) },
    ] } } });
    expect(metadata).toEqual({
      name: "Test User", email: "test@example.com", mode: "feedback",
      source: "s".repeat(240), osVersion: "10/11", submittedAt: expect.any(String),
    });
  });

  test("does not report success when Plain is not configured", async () => {
    delete process.env.PLAIN_API_KEY;
    expect((await POST(formRequest())).status).toBe(503);
    expect(requests).toHaveLength(0);
  });

  for (const operation of ["upsertCustomer", "createThread"]) {
    test(`handles ${operation} mutation errors without exposing provider details`, async () => {
      const index = operation === "upsertCustomer" ? 0 : 1;
      responses[index] = Response.json({ data: { [operation]: {
        error: { message: "Private provider detail", code: "VALIDATION_ERROR" },
      } } });
      const response = await POST(formRequest());
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("Private provider detail");
      expect(requests).toHaveLength(index + 1);
    });

    test(`rejects ${operation} responses missing the created resource`, async () => {
      const index = operation === "upsertCustomer" ? 0 : 1;
      responses[index] = Response.json({ data: { [operation]: { error: null } } });
      expect((await POST(formRequest())).status).toBe(502);
      expect(requests).toHaveLength(index + 1);
    });
  }

  for (const status of [401, 403, 429, 500]) {
    test(`handles Plain HTTP ${status} errors`, async () => {
      responses[0] = new Response("Private provider detail", { status });
      const response = await POST(formRequest());
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("Private provider detail");
      expect(requests).toHaveLength(1);
    });
  }

  test("handles GraphQL errors returned with HTTP 200", async () => {
    responses[0] = Response.json({ errors: [{ message: "Private provider detail" }] });
    expect((await POST(formRequest())).status).toBe(502);
    expect(requests).toHaveLength(1);
  });

  test("logs permission names from HTTP 403 errors without the provider's private details", async () => {
    responses[0] = Response.json({ errors: [{
      message: "Missing permission machineUser:read for test@example.com; machineUser:read required",
    }] }, { status: 403 });
    expect((await POST(formRequest())).status).toBe(502);
    expect(errorLog).toHaveBeenCalledWith("Plain form submission failed", {
      operation: "upsertCustomer",
      errorType: "ForbiddenError",
      code: "forbidden",
      permissions: ["machineUser:read"],
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("test@example.com");
  });

  test("handles network failures without exposing exception details", async () => {
    fetchMock.mockRejectedValue(new Error("Private connection detail"));
    const response = await POST(formRequest());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Private connection detail");
  });

  test("rejects invalid fields and spam before calling Plain", async () => {
    for (const invalid of [{ name: "" }, { email: "invalid" }, { message: "" }, { website: "spam" }, { startedAt: Date.now() }]) {
      expect((await POST(formRequest(invalid))).status).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  test("rejects untrusted origins and bots before calling Plain", async () => {
    expect((await POST(formRequest({}, "https://untrusted.example"))).status).toBe(403);
    checkBotId.mockResolvedValue({ isBot: true });
    expect((await POST(formRequest())).status).toBe(403);
    expect(requests).toHaveLength(0);
  });
});
