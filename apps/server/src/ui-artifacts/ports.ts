import type {
  UiArtifactBuild,
  UiArtifactCompilerDiagnostic,
  UiArtifactInstanceState,
  UiArtifactPinnedBuild,
  UiArtifactProjectFile,
  UiArtifactProjectFiles,
  UiArtifactProjectSnapshot,
  UiArtifactProjectSummary,
  UiArtifactSettings,
  UiArtifactSettingsUpdate,
} from "@openwork/types/ui-artifact-project";

export interface ArtifactProjectRepositoryPort {
  list(): Promise<UiArtifactProjectSummary[]>;
  get(slug: string): Promise<UiArtifactProjectSnapshot>;
  putFile(input: {
    slug: string;
    file: UiArtifactProjectFile;
    content: string;
    expectedRevision: string | null;
  }): Promise<UiArtifactProjectSnapshot>;
  putProject(input: {
    slug: string;
    files: UiArtifactProjectFiles;
    expectedRevision: string | null;
  }): Promise<UiArtifactProjectSnapshot>;
  getBuild(slug: string, projectRevision: string): Promise<UiArtifactPinnedBuild>;
  saveBuild(build: UiArtifactPinnedBuild): Promise<UiArtifactPinnedBuild>;
}

export type ArtifactCompileResult =
  | {
      ok: true;
      bundle: string;
      compiler: UiArtifactBuild["compiler"];
    }
  | {
      ok: false;
      diagnostics: UiArtifactCompilerDiagnostic[];
    };

export interface ArtifactCompilerPort {
  compile(source: string): ArtifactCompileResult;
}

export type ArtifactDataDiagnostic = {
  path: string;
  schemaPath: string;
  keyword: string;
  message: string;
};

export type ArtifactDataValidationResult =
  | { ok: true }
  | { ok: false; diagnostics: ArtifactDataDiagnostic[] };

export interface ArtifactDataValidatorPort {
  validate(schema: Record<string, unknown>, data: unknown): ArtifactDataValidationResult;
}

export interface ArtifactStateStorePort {
  get(input: {
    workspaceId: string;
    slug: string;
    instanceId: string;
  }): Promise<UiArtifactInstanceState>;
  initialize(input: {
    workspaceId: string;
    slug: string;
    instanceId: string;
    projectRevision: string;
    state: unknown;
  }): Promise<UiArtifactInstanceState>;
  update(input: {
    workspaceId: string;
    slug: string;
    instanceId: string;
    expectedRevision: string;
    state: unknown;
  }): Promise<UiArtifactInstanceState>;
}

export interface ArtifactSettingsStorePort {
  get(): Promise<UiArtifactSettings>;
  update(update: UiArtifactSettingsUpdate): Promise<UiArtifactSettings>;
}
