import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DenChipsCombobox } from "./chips-combobox";

test("selected values render as removable chips beside a labelled combobox input", () => {
  const html = renderToStaticMarkup(
    <DenChipsCombobox
      ariaLabel="Tasks for Claude"
      value={["Code review", "Quick questions"]}
      options={["Code review", "Writing"]}
      query=""
      onQueryChange={() => undefined}
      onChange={() => undefined}
    />,
  );
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-label="Tasks for Claude"/);
  assert.match(html, /aria-label="Remove Code review"/);
  assert.match(html, /aria-label="Remove Quick questions"/);
});

test("the placeholder only shows while nothing is selected", () => {
  const render = (value: string[]) => renderToStaticMarkup(
    <DenChipsCombobox ariaLabel="Tasks" value={value} options={[]} query="" placeholder="Add a task" onQueryChange={() => undefined} onChange={() => undefined} />,
  );
  assert.match(render([]), /placeholder="Add a task"/);
  assert.doesNotMatch(render(["Writing"]), /placeholder=/);
});
