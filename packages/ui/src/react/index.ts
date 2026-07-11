export {
  getSeededPaperGrainGradientConfig,
  getSeededPaperMeshGradientConfig,
  paperGrainGradientDefaults,
  paperMeshGradientDefaults,
  resolvePaperGrainGradientConfig,
  resolvePaperMeshGradientConfig,
} from "../common/paper"
export type {
  PaperGrainGradientConfig,
  PaperMeshGradientConfig,
  SeededPaperOption,
} from "../common/paper"
export { PaperGrainGradient } from "./paper/grain-gradient"
export type { PaperGrainGradientProps } from "./paper/grain-gradient"
export { PaperMeshGradient } from "./paper/mesh-gradient"
export type { PaperMeshGradientProps } from "./paper/mesh-gradient"
export { StaticSeededGradient } from "./paper/static-seeded-gradient"
export type { StaticSeededGradientProps } from "./paper/static-seeded-gradient"
export { DownloadOpenWorkCard } from "./download-card"
export type { DownloadCardInstallers } from "./download-card"
export { detectPlatform } from "./platform-detect"
export type { DetectedArch, DetectedOS, DetectedPlatform } from "./platform-detect"
