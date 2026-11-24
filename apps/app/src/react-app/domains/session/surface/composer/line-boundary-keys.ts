export type LineBoundaryMove = {
  alter: "move" | "extend";
  backward: boolean;
};

type LineBoundaryKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">;

export function lineBoundaryMoveForKey(event: LineBoundaryKeyEvent): LineBoundaryMove | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key !== "Home" && event.key !== "End") return null;
  return { alter: event.shiftKey ? "extend" : "move", backward: event.key === "Home" };
}
