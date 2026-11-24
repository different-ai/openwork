import { afterEach, expect, test, vi } from "vitest";
import { createDaytonaHost } from "./daytona.ts";
import type { DaytonaExec } from "./daytona.ts";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const calls: string[][] = [];
  const exec: DaytonaExec = async args => {
    calls.push(args);
    const command = args.join(" ");
    const stdout = args[0] === "preview-url" ? "https://desktop.example.test"
      : command.includes("OPENWORK_REMOTE_PID=") ? "OPENWORK_REMOTE_PID=4321"
      : command.includes('printf %s "$HOME"') ? "/home/daytona"
      : "";
    return { code: 0, stdout, stderr: "" };
  };
  return { calls, host: createDaytonaHost({ sandboxId: "owned-vm", repoRoot: "/unused", exec, log() {}, waitForCdp: async () => {} }) };
}

test("an environment-selected packaged desktop uses the tracked binary launcher", async () => {
  vi.stubEnv("OPENWORK_EVAL_ELECTRON_BINARY", "/opt/unsigned/openwork");
  const { host, calls } = fixture();
  const handle = await host.spawnElectron("packaged", {
    profileDir: "/tmp/packaged-profile", env: { HOME: "/tmp/packaged-profile/home", OPENWORK_AUTOMATION_RUNNER: "on" },
  });
  expect(handle.meta).toMatchObject({ binary: "/opt/unsigned/openwork", remotePid: "4321", profileOwner: "caller" });
  expect(calls.some(args => args.join(" ").includes("start-daytona-electron.sh"))).toBe(false);
  await host.disposeSurface(handle);
  expect(calls.some(args => args.join(" ").includes("/proc/4321/exe"))).toBe(true);
});

test("an explicit binary takes precedence over the environment override", async () => {
  vi.stubEnv("OPENWORK_EVAL_ELECTRON_BINARY", "/opt/environment/openwork");
  const { host } = fixture();
  const handle = await host.spawnElectron("explicit", { binaryPath: "/opt/explicit/openwork", env: { HOME: "/tmp/explicit/home" } });
  expect(handle.meta).toMatchObject({ binary: "/opt/explicit/openwork", remotePid: "4321" });
});

test("an explicit development command keeps source-launcher routing", async () => {
  vi.stubEnv("OPENWORK_EVAL_ELECTRON_BINARY", "/opt/environment/openwork");
  const { host, calls } = fixture();
  const handle = await host.spawnElectron("development", { devCommand: "dev" });
  expect(handle.meta?.binary).toBeUndefined();
  expect(calls.some(args => args.join(" ").includes("start-daytona-electron.sh"))).toBe(true);
});
