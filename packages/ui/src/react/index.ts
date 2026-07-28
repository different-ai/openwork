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
export { DownloadOpenWorkCard, DownloadPlatformGrid } from "./download-card"
export type { DownloadCardInstallers, DownloadPlatformGroup, DownloadPlatformOption } from "./download-card"
export { OpenWorkRoadmap, roadmapSections } from "./roadmap"
export type { RoadmapItem, RoadmapSection, RoadmapStatus } from "./roadmap"
export { detectPlatform } from "./platform-detect"
export type { DetectedArch, DetectedOS, DetectedPlatform } from "./platform-detect"
export { DitheredOnboardingShell } from "./dithered-onboarding-shell"
export type { DitheredOnboardingShellProps } from "./dithered-onboarding-shell"
