import type { Shot } from "./shot.ts";
import { denOpenworkWeb, denPluginDetail, denSkillEditor } from "./den-web.ts";
import {
  desktopTeamPromptCards,
  libraryAddMcpModal,
  libraryAdvancedSettings,
  libraryCreateSkillModal,
  librarySkills,
  skillCreatedCard,
} from "./desktop.ts";
import { openworkWebTab } from "./web-tab.ts";

export const shots: Shot[] = [
  desktopTeamPromptCards,
  librarySkills,
  libraryCreateSkillModal,
  libraryAdvancedSettings,
  libraryAddMcpModal,
  skillCreatedCard,
  denPluginDetail,
  denSkillEditor,
  denOpenworkWeb,
  openworkWebTab,
];
