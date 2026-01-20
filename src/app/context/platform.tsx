import { createContext, useContext, type ParentProps } from "solid-js";

export type SyncStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type AsyncStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type Platform = {
  platform: "web" | "desktop";
  os?: "macos" | "windows" | "linux";
  version?: string;
  openLink(url: string): void;
  restart(): Promise<void>;
  notify(title: string, description?: string, href?: string): Promise<void>;
  storage?: (name?: string) => SyncStorage | AsyncStorage;
  checkUpdate?: () => Promise<{ updateAvailable: boolean; version?: string }>;
  update?: () => Promise<void>;
  fetch?: typeof fetch;
  getDefaultServerUrl?: () => Promise<string | null>;
  setDefaultServerUrl?: (url: string | null) => Promise<void>;
};

const PlatformContext = createContext<Platform | undefined>(undefined);

export function PlatformProvider(props: ParentProps & { value: Platform }) {
  return (
    <PlatformContext.Provider value={props.value}>
      {props.children}
    </PlatformContext.Provider>
  );
}

export function usePlatform() {
  const context = useContext(PlatformContext);
  if (!context) {
    throw new Error("Platform context is missing");
  }
  return context;
}
