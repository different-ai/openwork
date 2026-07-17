import {
  $createLineBreakNode,
  $createTabNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  type LexicalNode,
} from "lexical";
import { PASTED_TEXT_INLINE_STYLE, splitPastedText } from "./pasted-text";

function createStyledPastedTextNodes(text: string) {
  const nodes: LexicalNode[] = [];
  for (const segment of splitPastedText(text)) {
    if (segment.kind === "line-break") {
      nodes.push($createLineBreakNode());
    } else if (segment.kind === "tab") {
      nodes.push($createTabNode());
    } else {
      const textNode = $createTextNode(segment.text);
      textNode.setStyle(PASTED_TEXT_INLINE_STYLE);
      nodes.push(textNode);
    }
  }

  return nodes;
}

export function insertStyledPastedText(text: string) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  selection.insertNodes(createStyledPastedTextNodes(text));
  const nextSelection = $getSelection();
  if ($isRangeSelection(nextSelection)) nextSelection.setStyle("");
  return true;
}
