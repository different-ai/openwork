import { describe, expect, test } from "bun:test";

import { OpenWorkMcpAuthorizationActions } from "./openwork-mcp-authorization-actions.js";

async function transform(error: string) {
  const plugin = await OpenWorkMcpAuthorizationActions();
  const output = {
    messages: [{
      info: { role: "assistant" },
      parts: [{
        type: "tool",
        tool: "salesforce_lookup",
        state: { status: "error", input: {}, error },
      }],
    }],
  };
  await plugin["experimental.chat.messages.transform"]({}, output);
  const message = output.messages[0];
  const part = message.parts[0];
  return part.state.error;
}

describe("OpenWorkMcpAuthorizationActions", () => {
  test("adds a safe user action to a flattened MCP authorization error", async () => {
    const url = "https://connect.example.test/salesforce/start";
    const error = `MCP error -32001: Authorization required. Open [${url}](${url}) in a browser.`;

    const transformed = await transform(error);

    expect(transformed).toContain(error);
    expect(transformed).toContain("[OpenWork authorization action]");
    expect(transformed).toContain(`present this exact URL as a Markdown link: ${url}`);
    expect(transformed).toContain("Do not open the URL yourself");
  });

  test("reads connect_url when the structured JSON-RPC error is available", async () => {
    const transformed = await transform(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32001,
        message: "Authorization required",
        data: {
          connect_url: "[https://connect.example.test/start](https://connect.example.test/start)",
          provider: "salesforce",
        },
      },
    }));

    expect(transformed).toContain("present this exact URL as a Markdown link: https://connect.example.test/start");
  });

  test("ignores unsafe connect URLs and unrelated tool errors", async () => {
    const unsafe = await transform(JSON.stringify({
      error: {
        code: -32001,
        message: "Authorization required",
        data: { connect_url: "javascript:alert(1)" },
      },
    }));
    const unrelated = await transform("MCP error -32603: Internal error at https://connect.example.test/start");

    expect(unsafe).not.toContain("[OpenWork authorization action]");
    expect(unrelated).not.toContain("[OpenWork authorization action]");
  });

  test("does not append the action more than once", async () => {
    const once = await transform(
      "MCP error -32001: Authorization required at https://connect.example.test/start",
    );
    const twice = await transform(once);

    expect(twice.match(/\[OpenWork authorization action\]/g)).toHaveLength(1);
  });
});
