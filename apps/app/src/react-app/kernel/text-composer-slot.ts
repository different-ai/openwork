import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";
import { createContext, type ComponentType, type ReactNode } from "react";

export type ComposerQuestion = {
  questions: QuestionInfo[];
  busy: boolean;
  requestId: string;
  onReply: (answers: string[][]) => unknown;
  onDismiss?: () => void;
  collapsible?: boolean;
  shortcutActive?: boolean;
};

export type TextComposerProps = {
  label: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void | Promise<void>;
  disabled: boolean;
  sending: boolean;
  question?: ComposerQuestion;
  topAccessory?: ReactNode;
  status?: string;
  sendLabel: string;
  onStop?: () => void | Promise<void>;
};

export const TextComposerSlot = createContext<ComponentType<TextComposerProps> | null>(null);
