import { expect, test } from "bun:test";
import { sandboxToolRenderer } from "@/lib/build-in-tools";
import { sandboxTransitionNote } from "@/react-app/kernel/sandbox-transition";
import { parseDynamicToolUIPart } from "@/react-app/domains/session/sync/parse-tool-parts";
import { describeTaskCreateFailure } from "@/react-app/shell/route-workspaces";

for (const [source, renderer] of Object.entries({ sandbox_shell: "bash", sandbox_read: "read", sandbox_write: "write", sandbox_edit: "edit", sandbox_glob: "glob", sandbox_grep: "grep", read: "read" })) {
  test(`${source} uses the ${renderer} renderer and keeps the sandbox result marker`, () => {
    expect(sandboxToolRenderer(source)).toBe(renderer);
    const part = parseDynamicToolUIPart({ type: "tool", id: "part", sessionID: "s", messageID: "m", callID: "c", tool: source,
      state: { status: "completed", input: {}, output: "result", title: "", metadata: { sandbox: true }, time: { start: 1, end: 2 } },
    });
    expect(part).toMatchObject({ toolName: renderer, callProviderMetadata: { openwork: { sandbox: true } } });
  });
}

test("task creation toast unwraps unrelated JSON proxy errors", () => {
  expect(describeTaskCreateFailure(new Error('{"code":"permission_denied","message":"Choose a different project."}'), 1).description).toBe("Choose a different project.");
});

test.each(["sandbox_engine_busy", "sandbox_engine_policy_pending", "sandbox_engine_activity_unavailable"])("%s produces a neutral transition note", (code) => {
  expect(sandboxTransitionNote(new Error(JSON.stringify({ code, message: "Old response." })))).toBe("Your sandbox setting applies when current tasks finish. Send this again then.");
  expect(sandboxTransitionNote({ code, status: 400 })).toBeNull();
});

test("keeps the new plain server message and scopes temporary 503s to a Force transition", () => {
  const message = "Your sandbox setting is saved and applies when current tasks finish. Send this again then.";
  expect(sandboxTransitionNote({ status: 409, code: "sandbox_engine_policy_pending", message })).toBe(message);
  expect(sandboxTransitionNote({ status: 503, error: "engine_v2_preview_not_running" }, true)).toBe("Applying your sandbox setting…");
  expect(sandboxTransitionNote({ status: 503, error: "engine_v2_preview_not_running" })).toBeNull();
  expect(sandboxTransitionNote({ status: 503, error: "unrelated" }, true)).toBeNull();
});
