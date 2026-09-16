import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { connectionMcpSetupUrl, McpConnectionAppSetup } from "../app/(den)/dashboard/_components/mcp-connection-app-setup";

let root: Root;
let container: HTMLDivElement;
const writeText = mock(async (_text: string) => undefined);
const connection = { id: "emc_saved", exposeDirectly: true };
const publicApiUrl = "https://api.example.test";

async function render(props: Partial<ComponentProps<typeof McpConnectionAppSetup>> = {}) {
  await act(async () => root.render(<McpConnectionAppSetup connection={connection} publicApiUrl={publicApiUrl} enabled {...props} />));
}

async function copy() {
  const button = container.querySelector("button");
  if (!button) throw new Error("Missing Copy button");
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}

beforeEach(() => {
  GlobalRegistrator.register({ url: "https://app.example.test" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  writeText.mockReset();
  writeText.mockImplementation(async () => undefined);
  spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mock.restore();
  await GlobalRegistrator.unregister();
});

test.each([
  ["https://api.example.test", "https://api.example.test/mcp/agent/connections/emc_saved%2Fid%20%23%3F"],
  ["https://api.example.test/", "https://api.example.test/mcp/agent/connections/emc_saved%2Fid%20%23%3F"],
  ["https://self-hosted.example.test/cloud/api/", "https://self-hosted.example.test/cloud/api/mcp/agent/connections/emc_saved%2Fid%20%23%3F"],
  ["https://self-hosted.example.test/cloud/api", "https://self-hosted.example.test/cloud/api/mcp/agent/connections/emc_saved%2Fid%20%23%3F"],
])("preserves the public API base %s and encodes the stable connection ID", (base, expected) => {
  expect(connectionMcpSetupUrl(base, "emc_saved/id #?")).toBe(expected);
});

test("renders compact OAuth steps and copies the public per-connection URL", async () => {
  await render();
  expect(container.querySelector("summary")?.textContent).toBe("Use in another app");
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelectorAll("li")).toHaveLength(3);
  expect(container.textContent).toContain("Choose OAuth and sign in to your OpenWork organization.");
  expect(container.textContent).toContain("You may still need to connect your provider account");
  expect(container.textContent).not.toContain("Copied");
  await copy();
  expect(writeText).toHaveBeenCalledWith("https://api.example.test/mcp/agent/connections/emc_saved");
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(container.querySelector("button")?.textContent).toBe("Copied");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("MCP URL copied.");
});

test("clipboard rejection shows a manual-copy error, not success, and allows retry", async () => {
  writeText.mockImplementationOnce(async () => { throw new Error("Permission denied"); });
  await render();
  await copy();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Select and copy it manually");
  expect(container.textContent).not.toContain("Copied");
  await copy();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("button")?.textContent).toBe("Copied");
});

test("a changed URL never retains success or an error from the previous URL", async () => {
  await render();
  await copy();
  await render({ connection: { ...connection, id: "emc_other" } });
  expect(container.querySelector("button")?.textContent).toBe("Copy");
  expect(container.querySelector('[role="status"]')).toBeNull();
  writeText.mockImplementationOnce(async () => { throw new Error("Permission denied"); });
  await copy();
  await render({ publicApiUrl: "https://self-hosted.example.test/prefix/" });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await copy();
  expect(writeText).toHaveBeenLastCalledWith("https://self-hosted.example.test/prefix/mcp/agent/connections/emc_saved");
});

test("late clipboard completion cannot claim a different URL was copied", async () => {
  let finishCopy = () => {};
  writeText.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCopy = resolve; }));
  await render();
  await copy();
  expect(container.querySelector("button")?.disabled).toBe(true);
  await render({ connection: { ...connection, id: "emc_other" } });
  await act(async () => finishCopy());
  expect(container.querySelector("button")?.textContent).toBe("Copy");
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test.each([
  { id: "emc_saved", exposeDirectly: false },
  { id: "google-workspace", exposeDirectly: true },
  { id: "microsoft-365", exposeDirectly: true },
  { id: "emc_native_google", exposeDirectly: true, nativeProviderKey: "google-workspace" },
  { id: "emc_native_microsoft", exposeDirectly: true, nativeProviderKey: "microsoft-365" },
])("does not expose an unexposed or native connection: %j", async (entry) => {
  await render({ connection: entry });
  expect(container.innerHTML).toBe("");
  expect(writeText).not.toHaveBeenCalled();
});

test("organization policy blocks the setup block even for a saved exposed connection", async () => {
  await render({ enabled: false });
  expect(container.innerHTML).toBe("");
});

test.each(["", "invalid", "/api/den", "https://app.example.test/api/den/", "ftp://api.example.test", "http://api.example.test", "http://localhost:8790", "http://[::1]:8790", "https://user:secret@api.example.test", "https://api.example.test?token=secret", "https://api.example.test#fragment"])("unavailable or unsafe public base %s cannot be copied or suggest setup is ready", async (base) => {
  expect(connectionMcpSetupUrl(base, connection.id)).toBeNull();
  await render({ publicApiUrl: base });
  expect(container.textContent).toContain("Public MCP URL unavailable");
  expect(container.querySelector("button")?.disabled).toBe(true);
  expect(container.querySelectorAll("li")).toHaveLength(0);
  await act(async () => container.querySelector("button")?.click());
  expect(writeText).not.toHaveBeenCalled();
});

test("missing configuration after a copy clears the copied feedback", async () => {
  await render();
  await copy();
  await render({ publicApiUrl: "" });
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector("button")?.textContent).toBe("Copy");
  expect(container.querySelector("button")?.disabled).toBe(true);
});
