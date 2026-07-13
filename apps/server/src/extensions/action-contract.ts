import type { ConnectSnapshot } from "../connect-contract.js";

export type ExtensionActionDescriptor = {
  readonly extensionId: string;
  readonly action: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type ExtensionActionHostContext = {
  readonly connectSnapshot?: ConnectSnapshot;
};

export type ExtensionActionInvocation = {
  readonly args: Readonly<Record<string, unknown>>;
  readonly clientContext: Readonly<Record<string, unknown>>;
  readonly hostContext: ExtensionActionHostContext;
};

export type ExtensionActionContribution = {
  readonly descriptor: ExtensionActionDescriptor;
  readonly isListed?: (context: ExtensionActionHostContext) => boolean;
  readonly execute?: (invocation: ExtensionActionInvocation) => Promise<Readonly<Record<string, unknown>>>;
};

export type ExtensionActionService = {
  readonly list: (extensionId: string, hostContext?: ExtensionActionHostContext) => readonly ExtensionActionDescriptor[];
  readonly call: (input: unknown, hostContext?: ExtensionActionHostContext) => Promise<unknown>;
};
