import type { Shot } from "./shot.ts";
import { denOpenworkWeb, denPluginDetail, denSkillEditor } from "./den-web.ts";
import {
  libraryAddMcpModal,
  libraryAddMcpSlack,
  libraryAdvancedSettings,
  libraryCreateSkillModal,
  librarySkills,
  librarySlackConnection,
  skillCreatedCard,
} from "./desktop.ts";
import { openworkWebTab } from "./web-tab.ts";

export const shots: Shot[] = [
  librarySkills,
  libraryCreateSkillModal,
  libraryAdvancedSettings,
  libraryAddMcpModal,
  libraryAddMcpSlack,
  librarySlackConnection,
  skillCreatedCard,
  denPluginDetail,
  denSkillEditor,
  denOpenworkWeb,
  openworkWebTab,
];
