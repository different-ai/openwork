import { useEffect, useState, type RefObject } from "react";

type SelectionReader = Pick<Selection, "getRangeAt" | "isCollapsed" | "rangeCount">;

export function selectionIntersectsElement(
  root: Element,
  selection: SelectionReader | null,
) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(root)) {
        return true;
      }
    } catch {
    }
  }

  return false;
}

export function useSelectionStableValue<T>(
  rootRef: RefObject<Element | null>,
  candidate: T,
) {
  const [committed, setCommitted] = useState(candidate);

  useEffect(() => {
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;

    if (!root || !ownerDocument || !selectionIntersectsElement(root, ownerDocument.getSelection())) {
      setCommitted((current) => Object.is(current, candidate) ? current : candidate);
      return;
    }

    let listening = true;
    const commitPending = () => {
      const liveRoot = rootRef.current;
      if (liveRoot && selectionIntersectsElement(liveRoot, ownerDocument.getSelection())) {
        return;
      }

      setCommitted((current) => Object.is(current, candidate) ? current : candidate);
      ownerDocument.removeEventListener("selectionchange", commitPending);
      listening = false;
    };

    ownerDocument.addEventListener("selectionchange", commitPending);
    return () => {
      if (listening) ownerDocument.removeEventListener("selectionchange", commitPending);
    };
  }, [candidate, rootRef]);

  return committed;
}
