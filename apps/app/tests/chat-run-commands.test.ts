import { describe, expect, test } from "bun:test";

import { renderHighlightedMarkdownHtml, renderMarkdownHtml, runnableShellCommand } from "../src/components/markdown/markdown-primitive";
import { runCommandPrompt } from "../src/react-app/domains/session/surface/run-command-prompt";

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
});
