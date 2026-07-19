import { afterEach, describe, expect, test } from "bun:test";

import { GET } from "../app/install-manifest.json/route";
import { isStandardDesktopAssetName } from "../lib/desktop-release-assets";
import { getGithubData } from "../lib/github";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function asset(name: string, url = `https://downloads.example.test/${name}`) {
  return { name, browser_download_url: url };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

describe("desktop release asset selection", () => {
  test("distinguishes public desktop installers from generic organization installers", () => {
    expect(isStandardDesktopAssetName("openwork-win-x64-0.17.1.exe")).toBe(true);
    expect(isStandardDesktopAssetName("openwork-mac-arm64-0.17.1.dmg")).toBe(true);
    expect(isStandardDesktopAssetName("openwork-linux-x86_64-0.17.1.AppImage")).toBe(true);

    expect(isStandardDesktopAssetName("openwork-installer-win-x64.exe")).toBe(false);
    expect(isStandardDesktopAssetName("openwork-server-win-x64.exe")).toBe(false);
    expect(isStandardDesktopAssetName("openwork-win-x64-0.17.1.exe.blockmap")).toBe(false);
  });

  test("landing downloads ignore generic installers even when GitHub lists them first", async () => {
    const standardWindows = asset("openwork-win-x64-0.17.1.exe");
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/different-ai/openwork")) {
        return jsonResponse({ stargazers_count: 16200 });
      }
      if (url.endsWith("/releases/latest")) {
        return jsonResponse({
          draft: false,
          prerelease: false,
          tag_name: "v0.17.1",
          html_url: "https://github.com/different-ai/openwork/releases/tag/v0.17.1",
          assets: [
            asset("openwork-installer-win-x64.exe"),
            standardWindows,
            asset("openwork-mac-arm64-0.17.1.dmg"),
            asset("openwork-linux-x86_64-0.17.1.AppImage"),
          ],
        });
      }
      if (url.includes("/releases?")) {
        return jsonResponse([]);
      }
      return new Response(null, { status: 404 });
    };

    const data = await getGithubData();

    expect(data.downloads.windows).toBe(standardWindows.browser_download_url);
    expect(data.installers.windows.x64).toBe(standardWindows.browser_download_url);
  });

  test("install manifest ignores generic installers when resolving Windows artifacts", async () => {
    const standardWindows = asset("openwork-win-x64-0.17.1.exe");
    globalThis.fetch = async () => jsonResponse([{
      draft: false,
      prerelease: false,
      tag_name: "v0.17.1",
      name: "v0.17.1",
      assets: [
        asset("openwork-installer-win-x64.exe"),
        standardWindows,
        asset("openwork-linux-x86_64-0.17.1.AppImage"),
      ],
    }]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.artifacts.win32.x64.url).toBe(standardWindows.browser_download_url);
  });
});
