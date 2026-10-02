import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const checkBotId = mock(async () => ({ isBot: false }));
mock.module("botid/server", () => ({ checkBotId }));

const { POST } = await import("../app/api/enterprise-contact/route");
const originalApiKey = process.env.LOOPS_API_KEY;
const fetchMock = spyOn(globalThis, "fetch");
let requestNumber = 0;

function contactRequest() {
  return new Request("https://openworklabs.com/api/enterprise-contact", {
    method: "POST",
    headers: {
      origin: "https://openworklabs.com",
      "content-type": "application/json",
      "x-forwarded-for": `enterprise-test-${++requestNumber}`,
    },
    body: JSON.stringify({
      fullName: "Test User",
      companyEmail: "test@example.com",
      message: "We want to roll out OpenWork.",
      startedAt: Date.now() - 5000,
      website: "",
    }),
  });
}

beforeEach(() => {
  process.env.LOOPS_API_KEY = "loops_test";
  checkBotId.mockResolvedValue({ isBot: false });
  fetchMock.mockClear();
  fetchMock.mockImplementation(Object.assign(async () => Response.json({ success: true }), { preconnect: globalThis.fetch.preconnect }));
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.LOOPS_API_KEY;
  else process.env.LOOPS_API_KEY = originalApiKey;
});

afterAll(() => {
  fetchMock.mockRestore();
});

describe("enterprise contact bot protection", () => {
  test("browser submissions that pass BotID reach Loops", async () => {
    const response = await POST(contactRequest());
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("agents flagged by BotID get the sales email and booking link instead of a dead end", async () => {
    checkBotId.mockResolvedValue({ isBot: true });
    const response = await POST(contactRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "form_requires_browser",
      message: expect.stringContaining("sales@openworklabs.com"),
      alternatives: {
        email: "sales@openworklabs.com",
        book: "https://openworklabs.com/enterprise#book",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
