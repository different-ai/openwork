export type PathEnv = Record<string, string | undefined>;

export interface PathOptions {
  env?: PathEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  userDataDir?: string;
}

export declare const MAX_CONFIG_ROOT_LENGTH: 4096;

export declare function micxConfigDir(opts?: PathOptions): string;
export declare function micxServerConfigPath(opts?: PathOptions): string;
export declare function micxEnvStorePath(opts?: PathOptions): string;
export declare function globalOpencodeConfigDir(opts?: PathOptions): string;
export declare function resolveGlobalOpencodeConfigPath(opts?: PathOptions): string;
export declare function workspaceOpencodeConfigCandidates(workspaceRoot: string): string[];
export declare function resolveWorkspaceOpencodeConfigPath(workspaceRoot: string): string;
export declare function desktopBootstrapPath(opts?: PathOptions): string;
export declare function legacyDesktopBootstrapPath(opts?: PathOptions): string;
export declare function expandHomePath(value: string, opts?: PathOptions): string;
export declare function micxServerDataDir(opts?: PathOptions): string;
export declare function opencodeDataDirs(opts?: PathOptions): string[];
export declare function opencodeCacheDirs(opts?: PathOptions): string[];
