// Placeholder build configuration. The per-client installer workflow
// (.github/workflows/build-client-installer.yml) overwrites this file with the
// client's deployment values before compiling. Empty values make the installer
// refuse to run unless OPENWORK_INSTALLER_* env overrides are provided, so a
// stray placeholder build can never point end users at the wrong deployment.
export const BUILD_APP_NAME = ""
export const BUILD_CLIENT_NAME = ""
export const BUILD_WEB_URL = ""
export const BUILD_API_URL = ""
export const BUILD_LOGO_URL = ""
export const BUILD_REQUIRE_SIGNIN = false
