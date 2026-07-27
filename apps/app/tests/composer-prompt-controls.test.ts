import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const composerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
);
const modelSelectPath = fileURLToPath(
  new URL("../src/components/model-select.tsx", import.meta.url),
);
const newTaskComposerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/chat/new-task-composer.tsx", import.meta.url),
);
const stylesheetPath = fileURLToPath(
  new URL("../src/app/index.css", import.meta.url),
);

describe("composer prompt controls", () => {
  test("docks the shared shadcn tools browser at composer width", () => {
    const source = readFileSync(composerPath, "utf8");
    const controls = source.slice(
      source.indexOf("<Collapsible"),
      source.indexOf("<ModelSelect"),
    );

    expect(controls).toContain("<Collapsible");
    expect(controls).toContain("<CollapsibleContent");
    expect(controls).toContain("<CollapsibleTrigger");
    expect(controls).toContain("<Tabs");
    expect(controls).toContain("<ScrollArea");
    expect(controls).toContain("<Select");
    expect(controls).toContain("<SelectContent");
    expect(controls).toContain("<Badge");
    expect(controls).toContain("<Empty");
    expect(controls).toContain("group-data-vertical/tabs:h-full");
    expect(controls).toContain("group-data-vertical/tabs:rounded-none");
    expect(controls).toContain("items-stretch justify-start");
    expect(controls).toContain('className="mb-1 h-auto flex-none justify-between py-2.5"');
    expect(controls).toContain('data-slot="composer-tools-separator"');
    expect(controls).not.toContain("<Popover");
    expect(controls).not.toContain("bg-white");
    expect(source).not.toContain("agentMenuRef");
    expect(source).not.toContain("toolMenuRef");
  });

  test("shares the same composer controls between drafts and conversations", () => {
    const newTaskComposer = readFileSync(newTaskComposerPath, "utf8");

    expect(newTaskComposer).toContain("<ReactSessionComposer");
  });

  test("keeps model and effort in one native shadcn menu", () => {
    const composer = readFileSync(composerPath, "utf8");
    const modelSelect = readFileSync(modelSelectPath, "utf8");

    expect(composer.match(/<ModelSelect/g)).toHaveLength(1);
    expect(composer).not.toContain("ModelBehaviorSelect");
    expect(modelSelect).toContain("<DropdownMenuSub");
    expect(modelSelect).toContain("<DropdownMenuRadioGroup");
    expect(modelSelect).toContain("<DropdownMenuRadioItem");
    expect(modelSelect).toContain("<Command");
    expect(modelSelect).toContain("data-model-settings-model-trigger");
    expect(modelSelect).toContain("data-model-settings-effort-trigger");
    expect(modelSelect).toContain("onKeyDown={(event) => event.stopPropagation()}");
    expect(modelSelect).not.toContain("<Popover");
    expect(modelSelect).not.toContain('className="text-xs"');
  });

  test("inherits the design-system font token instead of overriding it", () => {
    const stylesheet = readFileSync(stylesheetPath, "utf8");
    const bodyRule = stylesheet.match(/body\s*\{\s*margin:\s*0;[\s\S]*?\}/)?.[0] ?? "";

    expect(stylesheet).toContain("--font-sans:");
    expect(bodyRule).not.toBe("");
    expect(bodyRule).not.toContain("font-family");
  });
});
