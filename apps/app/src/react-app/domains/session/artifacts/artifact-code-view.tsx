/** @jsxImportSource react */
import { useCallback, useRef } from "react";
import { CodeView, EditProvider, type CreateEditor } from "@pierre/diffs/react";
import { Editor } from "@pierre/diffs/edit";

const OPENWORK_CODE_CSS = `
  :host {
    --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    display: block;
    min-height: 100%;
    background: var(--background);
  }
  [data-file] { min-height: 100%; }
`;

type ArtifactCodeViewProps = {
  name: string;
  path: string;
  content: string;
  editable?: boolean;
  onChange?: (content: string) => void;
};

export function ArtifactCodeView({ name, path, content, editable = false, onChange }: ArtifactCodeViewProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Once Pierre's editor attaches it owns the document; `content` only seeds
  // the initial doc. Re-renders must not push parent state (the autosave
  // draft) back into the editor, or the caret would reset mid-typing.
  // The component instance survives switching files, so reseed per path.
  const initialContentRef = useRef(content);
  const lastPathRef = useRef(path);
  if (lastPathRef.current !== path) {
    lastPathRef.current = path;
    initialContentRef.current = content;
  }
  const createEditor = useCallback<CreateEditor<undefined>>((options) => new Editor(options), []);

  return (
    <div className="h-full overflow-hidden bg-background" data-artifact-code-view={path}>
      <EditProvider createEditor={createEditor}>
        <CodeView
          className="h-full overflow-auto"
          disableWorkerPool
          items={[{
            id: path,
            type: "file",
            file: { name, contents: editable ? initialContentRef.current : content, cacheKey: path },
            edit: editable,
          }]}
          onItemEditChange={(_item, file) => {
            if (typeof file.contents === "string") onChangeRef.current?.(file.contents);
          }}
          options={{
            theme: { light: "github-light", dark: "github-dark" },
            disableFileHeader: true,
            overflow: "wrap",
            unsafeCSS: OPENWORK_CODE_CSS,
          }}
        />
      </EditProvider>
    </div>
  );
}
