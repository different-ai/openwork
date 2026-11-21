import { afterEach, describe, expect, test } from "bun:test";

import { createClientV2, createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter";
import { renderHighlightedMarkdownHtml, renderMarkdownHtml, runnableShellCommand } from "../src/components/markdown/markdown-primitive";
import { ranCommandNote, runCommandPrompt } from "../src/react-app/domains/session/surface/run-command-prompt";

const base = "http://127.0.0.1:9/workspace/ws_1/opencode2";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("chat run commands", () => {
  test("only a one-line shell block offers a command", () => {
    expect(runnableShellCommand("curl https://example.com\n", "bash")).toBe("curl https://example.com");
    expect(runnableShellCommand("$ git status", "console")).toBe("git status");
    expect(runnableShellCommand("ls -la", "sh title=list")).toBe("ls -la");
    expect(runnableShellCommand("cd app\npnpm test", "bash")).toBeNull();
    expect(runnableShellCommand("print('hi')", "python")).toBeNull();
    expect(runnableShellCommand("curl https://example.com", undefined)).toBeNull();
    expect(runnableShellCommand("   ", "bash")).toBeNull();
  });

  test("chat code blocks carry the command, plain and highlighted", async () => {
    const markdown = "```bash\ncurl \"https://example.com/?a=1&b=2\"\n```";
    const marked = 'data-openwork-code-run="curl &quot;https://example.com/?a=1&amp;b=2&quot;"';
    expect(renderMarkdownHtml(markdown, "chat")).toContain(marked);
    expect(await renderHighlightedMarkdownHtml(markdown, "chat")).toContain(marked);
    expect(renderMarkdownHtml("```bash\ncd app\npnpm test\n```", "chat")).not.toContain("data-openwork-code-run");
  });

  test("the sent message holds the exact command in a fence it cannot close", () => {
    expect(runCommandPrompt("git status")).toBe("Run this command, then continue from its output:\n\n```bash\ngit status\n```");
    expect(runCommandPrompt("echo ```")).toContain("````bash\necho ```\n````");
  });

  test("the note that wakes the agent names the command it must not run again", () => {
    expect(ranCommandNote("git status")).toContain("do not run it again");
    expect(ranCommandNote("echo ```")).toContain("````bash\necho ```\n````");
  });

  test("the v2 engine runs the command in the conversation and shows it as a shell step", async () => {
    const bodies: unknown[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/api/session/ses_1/shell")) {
          bodies.push(await request.json());
          return new Response(null, { status: 204 });
        }
        if (path.endsWith("/api/session/ses_1/message/msg_1")) {
          return Response.json({ data: {
            id: "msg_1", sessionID: "ses_1", type: "shell", shellID: "sh_1", command: "echo hi", status: "exited", exit: 0,
            time: { created: 10, completed: 20 }, output: { output: "hi\n", cursor: 3, size: 3, truncated: false },
          } });
        }
        return new Response(null, { status: 404 });
      },
    });
    const client = createClientV2(base, "/tmp/ws", { token: "t" });
    expect((await client.session.shell({ sessionID: "ses_1", command: "echo hi", messageID: "msg_1" })).error).toBeUndefined();
    expect(bodies).toEqual([{ command: "echo hi", id: "msg_1" }]);
    const message = (await client.session.message({ sessionID: "ses_1", messageID: "msg_1" })).data;
    expect(message?.info).toMatchObject({ id: "msg_1", role: "assistant", time: { created: 10, completed: 20 } });
    expect(message?.parts).toEqual([{
      id: "sh_1", messageID: "msg_1", sessionID: "ses_1", type: "tool", callID: "sh_1", tool: "bash",
      state: { status: "completed", input: { command: "echo hi" }, output: "hi\n", title: "bash", metadata: { output: "hi\n", exit: 0 }, time: { start: 10, end: 20 } },
    }]);
  });

  test("a command's start and end refresh the conversation", () => {
    const state = createV2EventTranslationState();
    const shell = { id: "sh_1", status: "running", command: "echo hi", cwd: "/tmp", shell: "zsh", file: "", metadata: {}, time: { started: 1 } };
    expect(translateV2Event({ type: "session.shell.started", data: { sessionID: "ses_1", shell } }, state))
      .toEqual([{ type: "openwork.message.refresh", properties: { sessionID: "ses_1" } }]);
    expect(translateV2Event({ type: "session.shell.ended", data: { sessionID: "ses_1", shell: { ...shell, metadata: { background: true } } } }, state))
      .toBeNull();
  });
});
