import { create } from "zustand";

/** Sent messages the agent has not read yet, by conversation. */
export type FollowUpDeliveryBook = Readonly<Record<string, readonly string[]>>;

export const emptyFollowUpDeliveryBook: FollowUpDeliveryBook = {};

export function addWaitingFollowUp(book: FollowUpDeliveryBook, sessionId: string, messageId: string): FollowUpDeliveryBook {
  const waiting = book[sessionId] ?? [];
  return waiting.includes(messageId) ? book : { ...book, [sessionId]: [...waiting, messageId] };
}

/** The agent read the message, or it was cancelled before that. */
export function settleWaitingFollowUp(book: FollowUpDeliveryBook, sessionId: string, messageId: string): FollowUpDeliveryBook {
  const waiting = book[sessionId];
  if (!waiting?.includes(messageId)) return book;
  const rest = waiting.filter((id) => id !== messageId);
  if (rest.length) return { ...book, [sessionId]: rest };
  return clearWaitingFollowUps(book, sessionId);
}

/** Nothing waits in a conversation that is no longer running. */
export function clearWaitingFollowUps(book: FollowUpDeliveryBook, sessionId: string): FollowUpDeliveryBook {
  if (!(sessionId in book)) return book;
  return Object.fromEntries(Object.entries(book).filter(([id]) => id !== sessionId));
}

export function isFollowUpWaiting(book: FollowUpDeliveryBook | undefined, sessionId: string, messageId: string): boolean {
  return book?.[sessionId]?.includes(messageId) ?? false;
}

type FollowUpDeliveryStore = {
  booksByWorkspaceId: Record<string, FollowUpDeliveryBook>;
  update: (workspaceId: string, change: (book: FollowUpDeliveryBook) => FollowUpDeliveryBook) => void;
};

export const useFollowUpDeliveryStore = create<FollowUpDeliveryStore>((set) => ({
  booksByWorkspaceId: {},
  update: (workspaceId, change) => set((state) => {
    const current = state.booksByWorkspaceId[workspaceId] ?? emptyFollowUpDeliveryBook;
    const next = change(current);
    return next === current ? state : { booksByWorkspaceId: { ...state.booksByWorkspaceId, [workspaceId]: next } };
  }),
}));
