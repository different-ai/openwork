/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parseSpreadsheet, type SpreadsheetRows } from "./artifact-spreadsheet-model";
import type { Data } from "./open-target";

type SpreadsheetSource =
  | { kind: "content"; content: Data; revision: number }
  | { kind: "rows"; rows: SpreadsheetRows };

type ArtifactSpreadsheetEditorProps = {
  className?: string;
  name: string;
  source: SpreadsheetSource;
  onChange: (rows: SpreadsheetRows) => void;
};

function cloneRows(rows: SpreadsheetRows): SpreadsheetRows {
  return rows.map((row) => [...row]);
}

function normalizeShape(rows: SpreadsheetRows): SpreadsheetRows {
  const width = Math.max(1, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

export function ArtifactSpreadsheetEditor(props: ArtifactSpreadsheetEditorProps) {
  const initialRows = props.source.kind === "rows" ? cloneRows(props.source.rows) : [[""]];
  const [rows, setRows] = useState<SpreadsheetRows>(initialRows);
  const rowsRef = useRef(rows);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);
  const onChangeRef = useRef(props.onChange);

  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  useEffect(() => {
    let cancelled = false;
    if (props.source.kind === "rows") {
      const nextRows = cloneRows(props.source.rows);
      rowsRef.current = nextRows;
      setRows(nextRows);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    void parseSpreadsheet({ name: props.name, content: props.source.content }).then(
      (nextRows) => {
        if (cancelled) return;
        const normalizedRows = normalizeShape(nextRows);
        rowsRef.current = normalizedRows;
        setRows(normalizedRows);
        setIsLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause);
        setIsLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.name, props.source.kind === "content" ? props.source.revision : null]);

  const updateRows = (update: (current: SpreadsheetRows) => SpreadsheetRows) => {
    const next = normalizeShape(update(rowsRef.current));
    rowsRef.current = next;
    setRows(next);
    onChangeRef.current(next);
  };

  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    updateRows((current) => {
      const next = cloneRows(current);
      next[rowIndex] = [...(next[rowIndex] ?? [])];
      next[rowIndex][columnIndex] = value;
      return next;
    });
  };

  const addRow = () => updateRows((current) => [
    ...current,
    Array.from({ length: Math.max(1, current[0]?.length ?? 1) }, () => ""),
  ]);
  const addColumn = () => updateRows((current) => current.map((row) => [...row, ""]));

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "Failed to prepare spreadsheet"}
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", props.className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="xs" onClick={addRow}><Plus className="size-3" /> Row</Button>
        <Button variant="ghost" size="xs" onClick={addColumn}><Plus className="size-3" /> Column</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={columnIndex} className="border-b not-first:border-l border-border p-0 align-top">
                    <input
                      className="h-8 w-full min-w-[120px] bg-transparent px-2 text-foreground outline-none focus:bg-muted/50"
                      value={cell}
                      onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
