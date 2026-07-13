export type InstallerConfig = {
  /** Organization-controlled display name. Signed app identity remains OpenWork. */
  appName: string
  /** Exact standard desktop release bundled with this installer, when present. */
  appVersion?: string | null
  clientName: string
  /** Den web origin — becomes `baseUrl` in desktop-bootstrap.json. */
  webUrl: string
  /** Den API origin — becomes `apiBaseUrl` in desktop-bootstrap.json. */
  apiUrl: string
  /** Optional client logo (png/svg URL) shown in the installer UI. */
  logoUrl: string | null
  /** Optional square app icon used for native desktop surfaces. */
  iconUrl?: string | null
  requireSignin: boolean
}

export {
  InstallerConfigMissingError,
  buildConstantsConfig,
  envOverrides,
  filenameTagConfig,
  installLinkConfig,
  installerConfigSourceLabel,
  parseInstallLinkInput,
  readSidecarConfig,
  resolveInstallerConfig,
  resolveOptionalInstallerConfig,
  type InstallerConfigResolution,
  type InstallerConfigSource,
} from "./config-sources"
