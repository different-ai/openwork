export type ChildOrigin = {
  parentId: string;
  pane: "primary" | "secondary";
  anchor: string;
  scrollTop: number;
  brief: string;
  messageId?: string;
  title?: string;
};

// Navigation context is transient and scoped to the runtime, never a shared draft.
const origins = new Map<string, ChildOrigin>();
const returning = new Map<string, ChildOrigin>();
const draftPersistence = new Map<string, () => void>();
const key = (scope: string, session: string) => JSON.stringify([scope, session]);
export function rememberChildOrigin(scope: string, child: string, origin: ChildOrigin) {
  origins.set(key(scope, child), origin);
  if (origins.size > 200) origins.delete(origins.keys().next().value!);
}
export function childOrigin(scope: string, child: string) { return origins.get(key(scope, child)); }
export function prepareChildReturn(scope: string, child: string) {
  draftPersistence.get(key(scope, child))?.();
  const origin = childOrigin(scope, child);
  if (origin) returning.set(key(scope, origin.parentId), origin);
  return origin;
}
/** Header, breadcrumb and keyboard return share the mounted child's draft flush. */
export function registerChildDraftPersistence(scope: string, child: string, persist: () => void) {
  const id = key(scope, child);
  draftPersistence.set(id, persist);
  return () => { if (draftPersistence.get(id) === persist) draftPersistence.delete(id); };
}
export function consumeChildReturn(scope: string, parent: string, pane?: ChildOrigin["pane"]) {
  const origin = returning.get(key(scope, parent));
  if (pane && origin?.pane !== pane) return undefined;
  returning.delete(key(scope, parent));
  return origin;
}
