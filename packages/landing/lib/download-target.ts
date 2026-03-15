import type { getGithubData } from "./github";

type GithubData = Awaited<ReturnType<typeof getGithubData>>;

const includesAny = (value: string, tokens: string[]) =>
  tokens.some((token) => value.includes(token));

const cleanClientHint = (value: string) => value.replaceAll('"', "").trim().toLowerCase();

export const resolveDownloadHref = (
  github: GithubData,
  headerStore: Pick<Headers, "get">
) => {
  const userAgent = String(headerStore.get("user-agent") || "").toLowerCase();
  const platformHint = cleanClientHint(String(headerStore.get("sec-ch-ua-platform") || ""));
  const archHint = cleanClientHint(String(headerStore.get("sec-ch-ua-arch") || ""));

  const isWindows =
    includesAny(platformHint, ["windows"]) ||
    includesAny(userAgent, ["windows", "win64", "win32"]);
  const isMac =
    includesAny(platformHint, ["mac"]) ||
    includesAny(userAgent, ["macintosh", "mac os", "darwin"]);
  const isLinux =
    includesAny(platformHint, ["linux"]) ||
    (includesAny(userAgent, ["linux", "x11"]) && !includesAny(userAgent, ["android"]));
  const isArm =
    includesAny(archHint, ["arm", "arm64", "aarch64"]) ||
    includesAny(userAgent, ["arm64", "aarch64"]);

  if (isWindows) {
    return isArm
      ? github.installers.windows.arm64
      : github.installers.windows.x64;
  }

  if (isMac) {
    return isArm
      ? github.installers.macos.appleSilicon
      : github.installers.macos.intel;
  }

  if (isLinux) {
    return github.downloads.linux;
  }

  return "/download";
};
