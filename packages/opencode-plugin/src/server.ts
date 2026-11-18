import { createPlugin } from "./plugin.ts"
import { initializeDesktopCredentialChannel } from "./desktop-credential-channel.ts"

await initializeDesktopCredentialChannel()

/** OpenCode V2 plugin entry (`Plugin.define` shape: `{ id, setup }`). */
export default createPlugin()
