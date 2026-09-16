import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeedbackUrl } from "../src/app/lib/feedback";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("feedback runtime context", () => {
  test("browser feedback identifies the UI build instead of the desktop placeholder", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    const url = new URL(buildFeedbackUrl({
      entrypoint: "status-bar", appVersion: "0.0.0-dev", buildSha: "abc1234",
      openworkServerVersion: "0.18.1",
    }));
    expect(url.searchParams.get("deployment")).toBe("web");
    expect(url.searchParams.get("appVersion")).toBe("web@abc1234");
    expect(url.searchParams.get("openworkServerVersion")).toBe("0.18.1");
    expect(url.searchParams.get("entrypoint")).toBe("status-bar");
  });

  test("settings feedback also reports web and omits a version without a build ID", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    const url = new URL(buildFeedbackUrl({
      entrypoint: "settings", appVersion: "0.0.0-dev", buildSha: "",
    }));
    expect(url.searchParams.get("deployment")).toBe("web");
    expect(url.searchParams.has("appVersion")).toBe(false);
  });

  test("a browser does not borrow a real desktop release version either", () => {
    const url = new URL(buildFeedbackUrl({
      entrypoint: "settings", deployment: "web", appVersion: "0.18.1", buildSha: "",
    }));
    expect(url.searchParams.has("appVersion")).toBe(false);
  });

  test("Electron feedback preserves the desktop release version", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true, value: { __OPENWORK_ELECTRON__: {} },
    });
    const url = new URL(buildFeedbackUrl({
      entrypoint: "status-bar", appVersion: "0.18.1-beta.2", buildSha: "abc1234",
    }));
    expect(url.searchParams.get("deployment")).toBe("desktop");
    expect(url.searchParams.get("appVersion")).toBe("0.18.1-beta.2");
  });

  test("unversioned desktop builds do not send the package placeholder", () => {
    for (const appVersion of ["0.0.0", "0.0.0-dev", "0.0.0+local"]) {
      const url = new URL(buildFeedbackUrl({ entrypoint: "settings", deployment: "desktop", appVersion }));
      expect(url.searchParams.has("appVersion")).toBe(false);
    }
  });

  test("built feedback code uses the embedded revision with the normal button inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwork-feedback-build-"));
    try {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/app/lib/feedback.ts")],
        outdir: directory,
        target: "browser",
        define: {
          "import.meta.env.VITE_OPENWORK_FEEDBACK_URL": JSON.stringify("https://example.com/feedback"),
          "import.meta.env.VITE_OPENWORK_APP_VERSION": JSON.stringify("0.0.0-dev"),
          "import.meta.env.VITE_OPENWORK_BUILD_SHA": JSON.stringify("fedcba9"),
        },
      });
      expect(build.success).toBe(true);
      const built = await import(join(directory, "feedback.js"));
      for (const entrypoint of ["status-bar", "settings"]) {
        const url = new URL(built.buildFeedbackUrl({ entrypoint }));
        expect(url.searchParams.get("deployment")).toBe("web");
        expect(url.searchParams.get("appVersion")).toBe("web@fedcba9");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
