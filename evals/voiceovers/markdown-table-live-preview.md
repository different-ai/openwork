# markdown-table-live-preview — Markdown tables render in the artifact editor

This user-facing proof drives the OpenWork desktop app over CDP, loads a document with markdown tables into a markdown artifact, and shows that the tables render as real tables while the document stays editable, that clicking or arrowing into one hands its markdown source back, and that a wide table no longer stops the surrounding prose from wrapping.

1. A markdown document with two tables opens in an artifact, and both tables are drawn as real tables with header rows, ruled cells, and the right-hand columns aligned to the right the way the markdown asked for. None of the pipe characters or the dashed divider row are left on screen as text.

2. Clicking a table hands its markdown straight back, pipes and all, with the cursor waiting on the row that was clicked. The other table on the page stays rendered, so editing one table does not turn the whole document back into source.

3. Typing another row into that markdown and then clicking away renders the table again with the new row in place, which is the loop someone actually uses to fill in a table by hand.

4. Arrow keys reach a table as well: pressing down from the lines above steps into the table's markdown instead of skipping over the whole block, and pressing up from the line below lands on its last row, so anyone editing with the keyboard can still get into a rendered table.

5. The wide table keeps its own column widths and scrolls inside its own box instead of stretching the document, so the paragraph next to it still wraps to the width of the panel.
