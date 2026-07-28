import {
  $createLineBreakNode,
  $createTabNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  type LexicalNode,
} from "lexical";
import { splitPastedText } from "./pasted-text";

function createPastedTextNodes(text: string) {
  const nodes: LexicalNode[] = [];
  for (const segment of splitPastedText(text)) {
    if (segment.kind === "line-break") {
      nodes.push($createLineBreakNode());
    } else if (segment.kind === "tab") {
      nodes.push($createTabNode());
    } else {
      nodes.push($createTextNode(segment.text));
    }
  }

  return nodes;
}

export function insertPastedText(text: string) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  selection.insertNodes(createPastedTextNodes(text));
  const nextSelection = $getSelection();
  if ($isRangeSelection(nextSelection)) nextSelection.setStyle("");
  return true;
}
