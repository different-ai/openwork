import { sessionAction, sessionActionCatalog, type SessionActionKind } from "../src/react-app/domains/session/sidebar/session-action-catalog";
import { sessionMenuActionsToPalette } from "../src/react-app/shell/command-palette-session-actions";

// These errors are mandatory: a new id needs a definition and every surface policy.
// @ts-expect-error Unknown actions cannot be constructed by UI callers.
sessionAction("future-action");
// @ts-expect-error Dynamic group choices need their explicit family id and label.
sessionAction("group");
// @ts-expect-error Group ids cannot be arbitrary command strings.
sessionAction("group", { id: "archive", label: "Named group" });
const missingSurface = { ...sessionActionCatalog.pin, surfaces: { menu: sessionActionCatalog.pin.surfaces.menu } };
// @ts-expect-error Adding an action without every adapter decision fails coverage.
const incomplete: typeof sessionActionCatalog & Record<"future-action", typeof sessionActionCatalog.pin> = { ...sessionActionCatalog, "future-action": missingSurface };
const future = { ...sessionAction("pin"), kind: "future-action" };
// @ts-expect-error An adapter cannot accept an unaccounted-for action.
sessionMenuActionsToPalette([future], "", () => {});
const known: SessionActionKind = "archive";
export { incomplete, known };
