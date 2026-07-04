export type InstallerConfig = {
  clientName: string
  /** Den web origin — becomes `baseUrl` in desktop-bootstrap.json. */
  webUrl: string
  /** Den API origin — becomes `apiBaseUrl` in desktop-bootstrap.json. */
  apiUrl: string
  /** Optional client logo (png/svg URL) shown in the installer UI. */
  logoUrl: string | null
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
