import type { Shot } from "./shot.ts";
import { denOpenworkWeb, denPluginDetail, denSkillEditor } from "./den-web.ts";
import {
  desktopTeamPromptCards,
  libraryAddMcpModal,
  libraryAdvancedSettings,
  libraryCreateSkillModal,
  librarySkills,
} from "./desktop.ts";
import {
  denLegacyProviderCatalogForm,
  denLegacyProviderCustomForm,
  denLegacyProviderDetail,
  denLegacyProviders,
  desktopCloudProviders,
} from "./providers.ts";
import { openworkWebTab } from "./web-tab.ts";

export const shots: Shot[] = [
  desktopTeamPromptCards,
  librarySkills,
  libraryCreateSkillModal,
  libraryAdvancedSettings,
  libraryAddMcpModal,
  denPluginDetail,
  denSkillEditor,
  denOpenworkWeb,
  openworkWebTab,
  denLegacyProviders,
  denLegacyProviderCatalogForm,
  denLegacyProviderCustomForm,
  denLegacyProviderDetail,
  desktopCloudProviders,
];
