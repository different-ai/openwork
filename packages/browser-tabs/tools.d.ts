export type BrowserToolContext = {
  abort?: AbortSignal;
  [key: string]: unknown;
};

export type BrowserTargetArgs = {
  browser_url: string;
  target_id?: string;
};

export type BrowserTool<Args> = {
  description: string;
  execute(args: Args, context?: BrowserToolContext): Promise<string>;
};

export type BrowserTools = {
  tool: {
    browser_list: BrowserTool<{ browser_url: string }>;
    browser_navigate: BrowserTool<BrowserTargetArgs & { url: string }>;
    browser_snapshot: BrowserTool<BrowserTargetArgs>;
    browser_click: BrowserTool<BrowserTargetArgs & { uid: number }>;
    browser_fill: BrowserTool<BrowserTargetArgs & { uid: number; value: string }>;
    browser_eval: BrowserTool<BrowserTargetArgs & { expression: string }>;
    browser_screenshot: BrowserTool<BrowserTargetArgs>;
  };
};

export type BrowserToolSocket = {
  readonly readyState: number;
  once(event: "open", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  send(payload: string): void;
  terminate(): void;
};

export type BrowserToolsOptions = {
  fetch?: typeof globalThis.fetch;
  WebSocket?: {
    new (endpoint: string): BrowserToolSocket;
    readonly OPEN: number;
  };
};

export function createBrowserTools(options?: BrowserToolsOptions): Promise<BrowserTools>;
