import { dialog, ipcMain, type BrowserWindow, type FileFilter } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { validateOptionalPathInput } from "../ipc/validation";

type DialogServiceOptions = {
  getMainWindow: () => BrowserWindow | null;
};

type PickDirectoryInput = {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
};

type PickFileInput = {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  filters?: FileFilter[];
};

type SaveFileInput = {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
};

function normalizeFileSelection(filePaths: string[], multiple?: boolean) {
  if (filePaths.length === 0) {
    return null;
  }

  if (multiple) {
    return filePaths;
  }

  return filePaths[0] ?? null;
}

function normalizeDefaultPath(defaultPath?: string) {
  return validateOptionalPathInput(defaultPath, {
    label: "defaultPath",
    allowRelative: true,
  }) ?? undefined;
}

export function createDialogService(options: DialogServiceOptions) {
  return {
    async pickDirectory(input: PickDirectoryInput = {}) {
      const properties: Array<"openDirectory" | "multiSelections"> = ["openDirectory"];
      if (input.multiple) {
        properties.push("multiSelections");
      }

      const dialogOptions = {
        title: input.title,
        defaultPath: normalizeDefaultPath(input.defaultPath),
        properties,
      };
      const parent = options.getMainWindow();
      const result = parent
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (result.canceled) {
        return null;
      }

      return normalizeFileSelection(result.filePaths, input.multiple);
    },

    async pickFile(input: PickFileInput = {}) {
      const properties: Array<"openFile" | "multiSelections"> = ["openFile"];
      if (input.multiple) {
        properties.push("multiSelections");
      }

      const dialogOptions = {
        title: input.title,
        defaultPath: normalizeDefaultPath(input.defaultPath),
        properties,
        filters: input.filters,
      };
      const parent = options.getMainWindow();
      const result = parent
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (result.canceled) {
        return null;
      }

      return normalizeFileSelection(result.filePaths, input.multiple);
    },

    async saveFile(input: SaveFileInput = {}) {
      const dialogOptions = {
        title: input.title,
        defaultPath: normalizeDefaultPath(input.defaultPath),
        filters: input.filters,
      };
      const parent = options.getMainWindow();
      const result = parent
        ? await dialog.showSaveDialog(parent, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

      if (result.canceled) {
        return null;
      }

      return result.filePath ?? null;
    },
  };
}

export type DialogService = ReturnType<typeof createDialogService>;

export function registerDialogIpc(service: DialogService) {
  ipcMain.handle(IPC_CHANNELS.dialogs("pickDirectory"), (_event, input?: PickDirectoryInput) =>
    service.pickDirectory(input),
  );
  ipcMain.handle(IPC_CHANNELS.dialogs("pickFile"), (_event, input?: PickFileInput) => service.pickFile(input));
  ipcMain.handle(IPC_CHANNELS.dialogs("saveFile"), (_event, input?: SaveFileInput) => service.saveFile(input));
}
