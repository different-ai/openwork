import type { ItemTone, PreviewItem } from "../../components/share-home-types.ts";
import type { OgImageVariant } from "./og-image-variants.ts";

export interface RequestLike {
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface BundleUrls {
  shareUrl: string;
  jsonUrl: string;
  downloadUrl: string;
}

export interface OgImageUrlSet {
  default: string;
  twitter: string;
  byVariant: Record<OgImageVariant, string>;
}

export interface OpenInAppUrls {
  openInAppDeepLink: string;
}

export interface NormalizedSkillItem {
  name: string;
  description: string;
  trigger: string;
  content: string;
}

export interface NormalizedCommandItem {
  name: string;
  description: string;
  template: string;
  content: string;
  agent: string;
  model: string;
  subtask: boolean;
}

export interface NormalizedPortableFileItem {
  path: string;
  content: string;
}

export interface NormalizedBundle {
  schemaVersion: number | null;
  type: string;
  name: string;
  description: string;
  trigger: string;
  content: string;
  workspace: Record<string, unknown> | null;
  skills: NormalizedSkillItem[];
  commands: NormalizedCommandItem[];
}

export interface BundleCounts {
  skillCount: number;
  commandCount: number;
  agentCount: number;
  mcpCount: number;
  configCount: number;
  fileCount: number;
  hasConfig: boolean;
}

export type ValidationResult =
  | { ok: true; bundle: NormalizedBundle }
  | { ok: false; message: string };

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export interface RawFileInput {
  path?: string;
  webkitRelativePath?: string;
  name?: string;
  content?: string;
}

export interface NormalizedFile {
  path: string;
  name: string;
  content: string;
}

export interface PackageInput {
  files?: RawFileInput[];
  bundleName?: string;
  preview?: boolean;
}

export interface PackageSummary {
  skills: number;
  agents: number;
  mcpServers: number;
  commands: number;
  configs: number;
  warnings: number;
}

export interface PackageResult {
  bundle: Record<string, unknown>;
  bundleType: string;
  name: string;
  summary: PackageSummary;
  warnings: string[];
  items: PreviewItem[];
}

export interface StoreBundleResult {
  id: string;
  pathname: string;
}

export interface FetchBundleResult {
  blob: { url: string; contentType: string };
  rawBuffer: Buffer;
  rawJson: string;
}

export interface BundlePageProps {
  missing: boolean;
  id?: string;
  title?: string;
  description?: string;
  canonicalUrl: string;
  shareUrl?: string;
  jsonUrl?: string;
  downloadUrl?: string;
  ogImageUrl: string;
  twitterImageUrl?: string;
  ogImageUrls?: OgImageUrlSet;
  openInAppDeepLink?: string;
  installHint?: string;
  bundleType?: string;
  typeLabel?: string;
  schemaVersion?: string;
  items?: PreviewItem[];
  previewFilename?: string;
  previewText?: string;
  previewLabel?: string;
  previewTone?: ItemTone;
  previewSelections?: {
    id: string;
    name: string;
    filename: string;
    text: string;
    label: string;
    tone: ItemTone;
  }[];
  metadataRows?: { label: string; value: string }[];
}
