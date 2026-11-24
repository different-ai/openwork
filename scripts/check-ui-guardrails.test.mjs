import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSource, makeBaseline, ratchet } from "./check-ui-guardrails.mjs";

const scan = (source) => scanSource("apps/app/src/fixture.tsx", source);
const rules = (source) => scan(source).map((finding) => finding.rule);

for (const [name, source, rule] of [
  ["absolute listbox", '<div role="listbox" className="absolute top-0" />', "unportaled-popup"],
  ["absolute menu ancestor", '<div className="relative"><div style={{ position: "absolute" }}><ul role={"menu"} /></div></div>', "unportaled-popup"],
  ["conditional absolute", '<div role="menu" className={cn(open && "absolute")} />', "unportaled-popup"],
  ["template absolute", '<div role="menu" className={`absolute ${open ? "block" : "hidden"}`} />', "unportaled-popup"],
  ["important absolute", '<div role="menu" className="!absolute" />', "unportaled-popup"],
  ["template faint text", '<p className={`text-gray-400 ${active ? "font-bold" : ""}`}>Body</p>', "faint-text"],
  ["raw checkbox", '<input type={"checkbox"} />', "raw-control"],
  ["raw select", '<select><option>A</option></select>', "raw-control"],
  ["faint label", '<label className="text-gray-400">Name</label>', "faint-text"],
  ["equivalent faint neutral", '<p className="dark:text-slate-300">Body</p>', "faint-text"],
  ["faint semantic opacity", '<p className="text-foreground/40">Body</p>', "faint-text"],
  ["tiny text", '<span className="text-[10px]">Label</span>', "tiny-text"],
  ["smaller text", '<span className="md:text-[9.5px]">Label</span>', "tiny-text"],
  ["tiny rem", '<span className="text-[0.625rem]">Label</span>', "tiny-text"],
  ["class constant", 'const body = "text-neutral-400";', "faint-text"],
]) test(name, () => assert.ok(rules(source).includes(rule)));

for (const [name, source] of [
  ["shared controls", '<><Switch /><Select><SelectContent /></Select><Input type="text" /></>'],
  ["Base UI portal", '<Select.Portal><div role="listbox" className="absolute" /></Select.Portal>'],
  ["shared portal", '<DropdownMenuPortal><div role="menu" className="absolute" /></DropdownMenuPortal>'],
  ["React portal", 'createPortal(<div role="menu" className="absolute" />, document.body)'],
  ["shared content portal", '<PopoverContent><ul role="menu" className="absolute" /></PopoverContent>'],
  ["static list", '<ul role="listbox" className="relative" />'],
  ["semantic text", '<p className="text-muted-foreground text-[13px]">Body</p>'],
  ["icon ink", '<svg className="text-gray-400" />'],
  ["comments", '// <select /> text-[9px]\n/* text-gray-400 */ const ok = 1;'],
  ["unrelated portal", '<><Select.Portal /><div className="relative" role="menu" /></>'],
]) test(name, () => assert.deepEqual(rules(source), []));

test("unrelated portal does not exempt an absolute menu", () => {
  assert.deepEqual(rules('<><Select.Portal /><div className="absolute" role="menu" /></>'), ["unportaled-popup"]);
});
test("ratchet tolerates line movement, not a duplicate or new file", () => {
  const source = '<input type="checkbox" />';
  const baseline = makeBaseline(scan(source));
  assert.deepEqual(ratchet(scan(`\n\n${source}`), baseline), []);
  assert.equal(ratchet(scan(`< >${source}${source}</>`), baseline).length, 1);
  assert.equal(ratchet(scanSource("ee/apps/den-web/new.tsx", source), baseline).length, 1);
});
test("fixed violations can be removed without a baseline refresh", () => {
  assert.deepEqual(ratchet(scan('<Switch />'), makeBaseline(scan('<input type="checkbox" />'))), []);
});
