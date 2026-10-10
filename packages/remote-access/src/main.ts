import { readConfig } from "./config.js";
import { macosPlatform } from "./platform/macos.js";
import { linuxPlatform } from "./platform/linux.js";
import { OpenWorkV2 } from "./adapters/openwork-v2-01857.js";
import { startBridge } from "./runtime.js";

try {
  const config = readConfig();
  const platform =
    process.platform === "darwin"
      ? macosPlatform()
      : process.platform === "linux"
        ? linuxPlatform()
        : null;
  if (!platform) throw Error("Unsupported host platform");
  const bridge = await startBridge({
    adapter: new OpenWorkV2(platform.discover),
    stateDirectory: platform.directories.state,
    platform: platform.platform,
    architecture: platform.architecture,
    origin: config.origin,
    admin: true,
  });
  console.log(
    "OpenWork Remote running. Open http://127.0.0.1:9289 locally to pair.",
  );
  const close = () => {
    void bridge.stop().catch(() => {
      console.error(
        "Bridge cleanup failed. Check local storage and listeners.",
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch {
  console.error(
    "Bridge did not start. Check supported OpenWork, private storage and loopback ports.",
  );
  process.exitCode = 1;
}
