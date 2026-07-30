import { FilesystemArtifactProjectRepository } from "./filesystem-repository.js";
import { JsonArtifactStateStore } from "./json-state-store.js";
import { JsonArtifactSettingsStore } from "./json-settings-store.js";
import { SafeJsonSchemaDataValidator } from "./json-schema-validator.js";
import { ArtifactProjectService } from "./service.js";
import { TypeScriptArtifactCompiler } from "./typescript-compiler.js";

export function createArtifactProjectService(input: {
  workspaceRoot: string;
  workspaceId: string;
}): ArtifactProjectService {
  const repository = new FilesystemArtifactProjectRepository(input.workspaceRoot);
  const compiler = new TypeScriptArtifactCompiler();
  const dataValidator = new SafeJsonSchemaDataValidator();
  const settingsStore = new JsonArtifactSettingsStore(input.workspaceRoot);
  const stateStore = new JsonArtifactStateStore(input.workspaceRoot);
  return new ArtifactProjectService(
    input.workspaceId,
    repository,
    compiler,
    dataValidator,
    settingsStore,
    stateStore,
  );
}

export {
  ArtifactProjectService,
  FilesystemArtifactProjectRepository,
  JsonArtifactStateStore,
  JsonArtifactSettingsStore,
  SafeJsonSchemaDataValidator,
  TypeScriptArtifactCompiler,
};
export type {
  ArtifactCompilerPort,
  ArtifactDataValidatorPort,
  ArtifactProjectRepositoryPort,
  ArtifactSettingsStorePort,
  ArtifactStateStorePort,
} from "./ports.js";
