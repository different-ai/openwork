/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { buildZip, utf8Bytes } = await import("@openwork/workbook");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { ArtifactPanel } = await import("../src/react-app/domains/session/artifacts/artifact-panel");
const { openTargetFromWorkspaceFile } = await import("../src/react-app/domains/session/artifacts/open-target");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type ArtifactPanelProps = Parameters<typeof ArtifactPanel>[0];
type Client = NonNullable<ArtifactPanelProps["client"]>;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let downloads: string[];
let files: Map<string, Uint8Array>;

function fakeClient(): Client {
  const client = {
    downloadWorkspaceFile: async (_workspaceId: string, path: string) => {
      downloads.push(path);
      const bytes = files.get(path) ?? new Uint8Array();
      const data = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(data).set(bytes);
      return { data, contentType: null, filename: path };
    },
    readWorkspaceFile: async (_workspaceId: string, path: string) => ({ path, content: "# Hello", updatedAt: 1 }),
  };
  // The panel only reads files in these cases; the rest of the client is unused.
  return Object.assign(Object.create(null), client);
}

async function open(path: string, size?: number, officePreview = true) {
  const target = openTargetFromWorkspaceFile(path, { size });
  if (!target) throw new Error(`no target for ${path}`);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <PlatformProvider value={createDefaultPlatform()}>
      <QueryClientProvider client={queryClient}>
        <ArtifactPanel
          sessionId="ses_test"
          tab={{ id: target.id, type: "artifact", label: target.name, preview: target.preview, target }}
          client={fakeClient()}
          workspaceId="ws_test"
          workspaceRoot="/tmp/workspace"
          officeDocumentPreview={officePreview}
          onClose={() => {}}
        />
      </QueryClientProvider>
    </PlatformProvider>,
  ));
  // Let the query resolve and React commit.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  downloads = [];
  files = new Map();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

test("files with no preview are not downloaded just to say so", async () => {
  await open("archive/backup.zip", 50_000_000);
  expect(downloads).toEqual([]);
  expect(host.textContent).toContain("This file can't be previewed here.");
});

test("legacy Office formats are not downloaded either", async () => {
  await open("deck.key", 4_000);
  expect(downloads).toEqual([]);
});

test("Word files open as a readable document", async () => {
  files.set("plan.docx", await buildZip([{
    name: "word/document.xml",
    data: utf8Bytes('<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p><w:p><w:r><w:t>Ship it.</w:t></w:r></w:p></w:body></w:document>'),
  }]));
  await open("plan.docx", 2_000);
  expect(downloads).toEqual(["plan.docx"]);
  const preview = host.querySelector('[data-testid="artifact-office-preview"]');
  expect(preview?.getAttribute("data-kind")).toBe("document");
  expect(preview?.textContent).toContain("Plan");
  expect(preview?.textContent).toContain("Ship it.");
});

test("with officeDocumentPreview off, Word files are not downloaded and open elsewhere", async () => {
  await open("plan.docx", 2_000, false);
  expect(downloads).toEqual([]);
  expect(host.querySelector('[data-testid="artifact-office-preview"]')).toBeNull();
  expect(host.textContent).toContain("This file can't be previewed here.");
});

test("oversized Word files skip the download", async () => {
  await open("huge.docx", 64 * 1024 * 1024);
  expect(downloads).toEqual([]);
  expect(host.textContent).toContain("This file is too large to preview.");
});

test("a damaged Word file says it can't be previewed", async () => {
  files.set("broken.docx", utf8Bytes("not a zip"));
  await open("broken.docx", 9);
  expect(host.textContent).toContain("This file can't be previewed here.");
});

test("markdown reads in a centered column", async () => {
  await open("notes.md", 7);
  const preview = host.querySelector("[data-openwork-markdown-preview]");
  expect(preview?.textContent).toContain("Hello");
  expect(preview?.firstElementChild?.className).toContain("max-w-[72ch]");
});
