import { useMemo } from "react";

import {
  APP_ACTIONS,
  actionKeys,
  useActionShortcutsStore,
  type AppActionId,
  type ShortcutTarget,
} from "@/react-app/kernel/app-actions";
import { formatChord, resolveShortcutOs } from "@/react-app/domains/shortcuts/shortcut-keys";
import { usePlatform } from "@/react-app/kernel/platform";

import type { PaletteItem } from "./command-palette-search";

const ALREADY_IN_PALETTE = new Set<AppActionId>([
  "command-palette.toggle",
  "session.new",
  "session-search.open",
  "session.archive.toggle",
  "terminal.toggle",
]);

export function useAppActionPaletteItems(input: {
  run: (target: ShortcutTarget) => void;
  close: () => void;
}): PaletteItem[] {
  const platform = usePlatform();
  const overrides = useActionShortcutsStore((state) => state.overrides);
  const skills = useActionShortcutsStore((state) => state.skills);
  const { run, close } = input;

  return useMemo(() => {
    const os = resolveShortcutOs(platform.os, typeof navigator === "undefined" ? "" : navigator.platform);
    const state = { overrides, skills };
    const trigger = (target: ShortcutTarget) => () => {
      close();
      run(target);
    };
    const actions = APP_ACTIONS.filter((definition) => !ALREADY_IN_PALETTE.has(definition.id))
      .map<PaletteItem>((definition) => {
        const keys = actionKeys(state, definition.id) ?? definition.fixedKeys?.chord ?? null;
        const shortcut = keys ? formatChord(keys, os) : undefined;
        return {
          id: `app-action.${definition.id}`,
          title: definition.label,
          meta: shortcut,
          shortcut,
          keywords: definition.keywords,
          group: "actions",
          action: trigger({ type: "app", actionId: definition.id }),
        };
      });
    const skillItems = skills.map<PaletteItem>((skill) => ({
      id: `app-action.skill.${skill.id}`,
      title: `Use /${skill.name}`,
      meta: formatChord(skill.keys, os),
      shortcut: formatChord(skill.keys, os),
      keywords: ["skill", skill.name],
      group: "actions",
      action: trigger({ type: "skill", name: skill.name }),
    }));
    return [...actions, ...skillItems];
  }, [close, overrides, platform.os, run, skills]);
}
