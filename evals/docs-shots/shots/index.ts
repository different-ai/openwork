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
import { workshopShots } from "./workshop.ts";

export const documentationShots: Shot[] = [
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

// Attached workshop captures are explicit opt-in, never part of a default docs
// regeneration. --list still discovers every registered scene without a world.
const includeWorkshop = process.argv.includes("--list") || process.argv.some((arg) => arg.startsWith("workshop-"));
export const shots: Shot[] = [...documentationShots, ...(includeWorkshop ? workshopShots : [])];
