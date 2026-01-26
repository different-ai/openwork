import { createSignal } from "solid-js";

import type { CommandRegistryItem } from "./types";

type RegisteredCommand = CommandRegistryItem & { key: string };

export function createCommandRegistry() {
  const [items, setItems] = createSignal<RegisteredCommand[]>([]);
  let counter = 0;

  const registerCommand = (command: CommandRegistryItem) => {
    const key = `${command.id}-${counter++}`;
    const entry: RegisteredCommand = { ...command, key };
    setItems((prev: RegisteredCommand[]) => [...prev, entry]);
    return () =>
      setItems((prev: RegisteredCommand[]) => prev.filter((item) => item.key !== key));
  };

  const registerCommands = (commands: CommandRegistryItem[]) => {
    const cleanups = commands.map(registerCommand);
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  };

  return {
    items,
    registerCommand,
    registerCommands,
  };
}
