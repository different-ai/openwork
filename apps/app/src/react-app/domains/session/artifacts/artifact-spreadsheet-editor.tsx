/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { parseSpreadsheet, serializeSpreadsheet, type SpreadsheetRows } from "./artifact-spreadsheet-model";
import { cn } from "@/lib/utils";
import type { Data } from "./open-target";

type ArtifactSpreadsheetEditorProps = {
  className?: string;
  name: string;
  content: Data;
  saving?: boolean;
  onSave: (payload: Data) => void | Promise<void>;
};

function cloneRows(rows: SpreadsheetRows): SpreadsheetRows {
  return rows.map((row) => [...row]);
}

function normalizeShape(rows: SpreadsheetRows): SpreadsheetRows {
  const width = Math.max(1, ...rows.map((row) => row.length));

  return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

interface UseSpreadsheetProps {
  name: string;
  content: Data;
  onSave: (payload: Data) => void | Promise<void>;
}

function useSpreadsheet({ name, content, onSave }: UseSpreadsheetProps) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["artifact-spreadsheet", name, content] as const,
    queryFn: async () => normalizeShape(await parseSpreadsheet({ name, content })),
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const [rows, setRows] = useState<SpreadsheetRows>([[""]]);
  const [baseRows, setBaseRows] = useState<SpreadsheetRows>([[""]]);
  const isDirty = useMemo(() => JSON.stringify(rows) !== JSON.stringify(baseRows), [baseRows, rows]);

  useEffect(() => {
    if (!data) {
      return;
    }

    setRows(data);
    setBaseRows(cloneRows(data));
  }, [data]);

  const { mutate: save, isPending: isSaving } = useMutation({
    mutationFn: async () => {
      const serialized = await serializeSpreadsheet(name, rows);

      await onSave(serialized);
    },
    onSuccess: () => {
      setBaseRows(cloneRows(rows));
    },
  });

  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    setRows((current) => {
      const next = cloneRows(current);

      next[rowIndex] = [...(next[rowIndex] ?? [])];
      next[rowIndex][columnIndex] = value;

      return normalizeShape(next);
    });
  };

  const addRow = () => setRows((current) => [...current, Array.from({ length: Math.max(1, current[0]?.length ?? 1) }, () => "")]);
  const addColumn = () => setRows((current) => current.map((row) => [...row, ""]));
  const discard = () => setRows(cloneRows(baseRows));

  return { rows, error, isLoading, updateCell, addRow, addColumn, discard, isDirty, save, isSaving };
}

export function ArtifactSpreadsheetEditor(props: ArtifactSpreadsheetEditorProps) {
  const { rows, error, isLoading, updateCell, addRow, addColumn, discard, isDirty, save, isSaving } = useSpreadsheet(props);
  const saving = props.saving || isSaving;

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
        {error instanceof Error ? error.message : "Failed to parse spreadsheet"}
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", props.className)}>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 border-b border-border">
        <Button variant="ghost" size="xs" onClick={addRow}><Plus className="size-3" /> Row</Button>
        <Button variant="ghost" size="xs" onClick={addColumn}><Plus className="size-3" /> Column</Button>
        <div className="min-w-0 flex-1" />
        <Button variant="ghost" size="xs" onClick={discard} disabled={!isDirty || saving}>Discard</Button>
        <Button variant="default" size="xs" onClick={() => save()} disabled={!isDirty || saving}>{saving ? "Saving" : "Save"}</Button>
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
