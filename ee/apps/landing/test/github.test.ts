import { afterEach, describe, expect, test } from "bun:test";
import { getGithubData } from "../lib/github";

type GithubFixtureAsset = {
  name: string;
  browser_download_url: string;
};

type GithubFixtureRelease = {
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  tag_name: string;
  assets: GithubFixtureAsset[];
};

type GithubFetchFixtures = {
  latestRelease: GithubFixtureRelease;
  releases: GithubFixtureRelease[];
};

const repoUrl = "https://api.github.com/repos/different-ai/openwork";
const latestReleaseUrl = "https://api.github.com/repos/different-ai/openwork/releases/latest";
const releasesUrl = "https://api.github.com/repos/different-ai/openwork/releases?per_page=50";
const fallbackReleaseUrl = "https://github.com/different-ai/openwork/releases";
const releaseTag = "v0.17.38";
const releasePageUrl = `${fallbackReleaseUrl}/tag/${releaseTag}`;
const downloadBaseUrl = `${fallbackReleaseUrl}/download/${releaseTag}`;
const originalFetch = globalThis.fetch;

const asset = (name: string): GithubFixtureAsset => ({
  name,
  browser_download_url: `${downloadBaseUrl}/${name}`
});

const installGithubFetch = ({ latestRelease, releases }: GithubFetchFixtures) => {
  const fixtures: Record<string, unknown> = {
    [repoUrl]: { stargazers_count: 12345 },
    [latestReleaseUrl]: latestRelease,
    [releasesUrl]: releases
  };

  const fetchStub = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const fixture = fixtures[url];

      if (fixture === undefined) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    { preconnect: originalFetch.preconnect }
  ) satisfies typeof fetch;

  globalThis.fetch = fetchStub;
};

const releaseWithAssets = (assets: GithubFixtureAsset[]): GithubFixtureRelease => ({
  draft: false,
  prerelease: false,
  html_url: releasePageUrl,
  tag_name: releaseTag,
  assets
});

const expectNoInstallerUrl = (url: string) => {
  expect(url.length).toBeGreaterThan(0);
  expect(url.toLowerCase()).not.toContain("installer");
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getGithubData", () => {
  test("selects only public desktop assets when installer assets are listed first", async () => {
    const macArm64 = asset("openwork-mac-arm64-0.17.38.dmg");
    const macX64 = asset("openwork-mac-x64-0.17.38.dmg");
    const winArm64 = asset("openwork-win-arm64-0.17.38.exe");
    const winX64 = asset("openwork-win-x64-0.17.38.exe");
    const linuxX64 = asset("openwork-linux-x86_64-0.17.38.AppImage");
    const release = releaseWithAssets([
      asset("OpenWork-Installer-mac-arm64.dmg"),
      asset("OpenWork-Installer-mac-x64.dmg"),
      asset("OpenWork-Installer-win-x64.exe"),
      asset("openwork-cloud-mac-arm64-0.17.38.dmg"),
      asset("openwork-cloud-mac-x64-0.17.38.dmg"),
      asset("openwork-cloud-win-x64-0.17.38.exe"),
      asset("openwork-cloud-linux-x86_64-0.17.38.AppImage"),
      asset("openwork-enterprise-mac-arm64-0.17.38.dmg"),
      asset("openwork-enterprise-mac-x64-0.17.38.dmg"),
      asset("openwork-enterprise-win-x64-0.17.38.exe"),
      asset("openwork-enterprise-linux-x86_64-0.17.38.AppImage"),
      macArm64,
      macX64,
      winArm64,
      winX64,
      linuxX64
    ]);

    installGithubFetch({ latestRelease: release, releases: [release] });

    const data = await getGithubData();

    expectNoInstallerUrl(data.downloads.macos);
    expectNoInstallerUrl(data.downloads.windows);
    expectNoInstallerUrl(data.downloads.linux);
    expect(data.installers.macos.appleSilicon).toBe(macArm64.browser_download_url);
    expect(data.installers.macos.intel).toBe(macX64.browser_download_url);
    expect(data.installers.windows.x64).toBe(winX64.browser_download_url);
    expect(data.installers.windows.arm64).toBe(winArm64.browser_download_url);
    expect(data.releaseTag).toBe(releaseTag);
  });

  test("falls back to release pages when a release contains only installer assets", async () => {
    const release = releaseWithAssets([
      asset("OpenWork-Installer-mac-arm64.dmg"),
      asset("OpenWork-Installer-mac-x64.dmg"),
      asset("OpenWork-Installer-win-x64.exe")
    ]);

    installGithubFetch({ latestRelease: release, releases: [release] });

    const data = await getGithubData();
    const returnedUrls = [
      data.downloads.macos,
      data.downloads.windows,
      data.downloads.linux,
      data.installers.macos.appleSilicon,
      data.installers.macos.intel,
      data.installers.windows.x64,
      data.installers.windows.arm64,
      data.installers.linux.appImageX64,
      data.installers.linux.appImageArm64,
      data.installers.linux.tarX64,
      data.installers.linux.tarArm64
    ];

    for (const url of returnedUrls) {
      expectNoInstallerUrl(url);
    }

    expect(data.downloads).toEqual({
      macos: fallbackReleaseUrl,
      windows: fallbackReleaseUrl,
      linux: fallbackReleaseUrl
    });
    expect(data.installers.macos.appleSilicon).toBe(releasePageUrl);
    expect(data.installers.macos.intel).toBe(releasePageUrl);
    expect(data.installers.windows.x64).toBe(releasePageUrl);
    expect(data.installers.windows.arm64).toBe(releasePageUrl);
    expect(data.installers.linux.appImageX64).toBe(releasePageUrl);
    expect(data.installers.linux.appImageArm64).toBe(releasePageUrl);
    expect(data.installers.linux.tarX64).toBe(releasePageUrl);
    expect(data.installers.linux.tarArm64).toBe(releasePageUrl);
    expect(data.releaseUrl).toBe(releasePageUrl);
    expect(data.releaseTag).toBe(releaseTag);
  });
});
