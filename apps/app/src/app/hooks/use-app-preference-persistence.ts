import { createEffect, type Accessor } from "solid-js";

import { HIDE_TITLEBAR_PREF_KEY, MODEL_PREF_KEY, THINKING_PREF_KEY, VARIANT_PREF_KEY } from "../constants";
import type { ModelRef } from "../types";
import { formatModelRef, isTauriRuntime } from "../utils";
import { setWindowDecorations } from "../lib/tauri";

type UpdateStatusSnapshot = {
  state: string;
  lastCheckedAt?: number | null;
};

type UseAppPreferencePersistenceOptions = {
  baseUrl: Accessor<string>;
  clientDirectory: Accessor<string>;
  workspaceProjectDir: Accessor<string>;
  engineSource: Accessor<string>;
  engineCustomBinPath: Accessor<string>;
  engineRuntime: Accessor<string>;
  opencodeEnableExa: Accessor<boolean>;
  defaultModel: Accessor<ModelRef>;
  updateAutoCheck: Accessor<boolean>;
  updateAutoDownload: Accessor<boolean>;
  showThinking: Accessor<boolean>;
  hideTitlebar: Accessor<boolean>;
  modelVariantMap: Accessor<Record<string, string>>;
  updateStatus: Accessor<UpdateStatusSnapshot>;
};

const withStorage = (callback: (storage: Storage) => void) => {
  if (typeof window === "undefined") return;
  try {
    callback(window.localStorage);
  } catch {
    // ignore
  }
};

export function useAppPreferencePersistence(options: UseAppPreferencePersistenceOptions) {
  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.baseUrl", options.baseUrl());
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.clientDirectory", options.clientDirectory());
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.projectDir", options.workspaceProjectDir());
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.engineSource", options.engineSource());
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      const value = options.engineCustomBinPath().trim();
      if (value) {
        storage.setItem("openwork.engineCustomBinPath", value);
      } else {
        storage.removeItem("openwork.engineCustomBinPath");
      }
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.engineRuntime", options.engineRuntime());
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.opencodeEnableExa", options.opencodeEnableExa() ? "1" : "0");
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem(MODEL_PREF_KEY, formatModelRef(options.defaultModel()));
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.updateAutoCheck", options.updateAutoCheck() ? "1" : "0");
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem("openwork.updateAutoDownload", options.updateAutoDownload() ? "1" : "0");
    });
  });

  createEffect(() => {
    withStorage((storage) => {
      storage.setItem(THINKING_PREF_KEY, JSON.stringify(options.showThinking()));
    });
  });

  createEffect(() => {
    const hide = options.hideTitlebar();
    withStorage((storage) => {
      storage.setItem(HIDE_TITLEBAR_PREF_KEY, JSON.stringify(hide));
    });
    if (isTauriRuntime()) {
      setWindowDecorations(!hide).catch(() => {
        // ignore
      });
    }
  });

  createEffect(() => {
    withStorage((storage) => {
      const map = options.modelVariantMap();
      if (Object.keys(map).length > 0) {
        storage.setItem(VARIANT_PREF_KEY, JSON.stringify(map));
      } else {
        storage.removeItem(VARIANT_PREF_KEY);
      }
    });
  });

  createEffect(() => {
    const state = options.updateStatus();
    if (state.state !== "idle" || !state.lastCheckedAt) return;
    withStorage((storage) => {
      storage.setItem("openwork.updateLastCheckedAt", String(state.lastCheckedAt));
    });
  });
}
