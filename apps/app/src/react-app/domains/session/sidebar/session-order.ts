import type { SidebarSessionItem } from "../../../../app/types";

const createdAt = (session: SidebarSessionItem) => {
  const value = session.time?.created;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

export function getSessionOrder(sessions: SidebarSessionItem[], savedIds: string[]): string[] {
  const saved = new Set(savedIds);
  const arrivals = sessions.filter(session => !saved.has(session.id)).sort((left, right) =>
    createdAt(right) - createdAt(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return [...new Set([
    ...arrivals.filter(session => createdAt(session) > 0).map(session => session.id),
    ...saved,
    ...arrivals.filter(session => createdAt(session) <= 0).map(session => session.id),
  ])];
}

export function moveSessionInOrder(order: string[], sourceId: string, targetId: string, after: boolean): string[] {
  if (sourceId === targetId || !order.includes(sourceId) || !order.includes(targetId)) return order;
  const next = order.filter(id => id !== sourceId);
  next.splice(next.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
  return next;
}
