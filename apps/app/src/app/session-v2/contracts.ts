import type { MessageWithParts, TodoItem, WorkspaceSessionGroup } from "../types";

export type SessionV2ViewModel = {
  selectedSessionId: string | null;
  selectedWorkspaceId: string;
  sessionTitle: string;
  workspaceLabel: string;
  headerStatus: string;
  busyHint: string | null;
  searchOpen: boolean;
  searchQuery: string;
  searchPositionLabel: string;
  searchHasHits: boolean;
  commandPaletteOpen: boolean;
  commandPaletteTitle: string;
  commandPaletteMode: string;
  commandPaletteQuery: string;
  commandPalettePlaceholder: string;
  messages: MessageWithParts[];
  todos: TodoItem[];
  todoExpanded: boolean;
  todoLabel: string;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  sessionStatusById: Record<string, string>;
  newTaskDisabled: boolean;
};

export type SessionV2CommandPaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  action: () => void;
};

export type SessionV2CommandPort = {
  openSettings: () => void;
  openSession: (sessionId: string) => void;
  selectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  createTaskInWorkspace: (workspaceId: string) => void;
  openCreateWorkspace: () => void;
  toggleSearch: () => void;
  setSearchQuery: (value: string) => void;
  moveSearchHit: (direction: -1 | 1) => void;
  closeSearch: () => void;
  setTodoExpanded: (value: boolean | ((current: boolean) => boolean)) => void;
  sendPrompt: (text: string) => Promise<void>;
  setPrompt: (value: string) => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  returnToCommandRoot: () => void;
  setCommandPaletteQuery: (value: string) => void;
  setCommandPaletteActiveIndex: (value: number | ((current: number) => number)) => void;
};
