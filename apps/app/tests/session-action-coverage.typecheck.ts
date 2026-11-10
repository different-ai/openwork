import { sessionAction, sessionActionCatalog } from "../src/react-app/domains/session/sidebar/session-action-catalog";
import { sessionMenuActionsToPalette } from "../src/react-app/shell/command-palette-session-actions";

// Compiled only by the resolver test's createProgram, not the shipped app tsconfig.
// @ts-expect-error Unknown actions cannot be constructed by UI callers.
sessionAction("future-action");
const { pin, ...missingPin } = sessionActionCatalog;
// @ts-expect-error Each known action needs a catalog definition.
const incompleteCatalog: typeof sessionActionCatalog = missingPin;
const { feedQuick, ...missingProjection } = pin;
// @ts-expect-error Every definition must explicitly declare each projection.
const incompleteDefinition: typeof pin = missingProjection;
const future = { ...sessionAction("pin"), kind: "future-action" };
// @ts-expect-error An adapter cannot accept an unknown action kind.
sessionMenuActionsToPalette([future], "", () => {});
