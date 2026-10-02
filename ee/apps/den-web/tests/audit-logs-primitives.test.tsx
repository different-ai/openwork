import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LockKeyhole } from "lucide-react";
import { DenPageHeader } from "../app/(den)/_components/ui/page-header";
import { DenTable } from "../app/(den)/_components/ui/table";
import { DenNotice } from "../app/(den)/_components/ui/notice";

const tableProps = { rows: ["operation-a"], columns: [{ key: "operation", header: "Operation", render: (row: string) => row }], getRowKey: (row: string) => row };

test("compact headings use the small title without changing default pages", () => {
  const compact = renderToStaticMarkup(<DenPageHeader title="Audit logs" size="compact" />);
  expect(compact).toContain("text-xl");
  expect(compact).not.toContain("text-[28px]");
  expect(compact).not.toContain("<p");
  expect(renderToStaticMarkup(<DenPageHeader title="Existing page" />)).toContain("text-[28px]");
});

test("compact tables have sentence-case headings, tighter rows, and no empty detail row", () => {
  const compact = renderToStaticMarkup(<DenTable {...tableProps} density="compact" renderRowDetail={() => null} />);
  expect(compact).not.toContain("uppercase");
  expect(compact).toContain("px-3 py-2");
  expect(compact).not.toContain("colSpan");
  const normal = renderToStaticMarkup(<DenTable {...tableProps} renderRowDetail={() => null} />);
  expect(normal).toContain("uppercase");
  expect(normal).toContain("px-6 py-3");
  expect(normal.toLowerCase()).toContain("colspan");
});

test("blocked notices are neutral status with a lock rather than an error", () => {
  const locked = renderToStaticMarkup(<DenNotice icon={LockKeyhole} tone="neutral" message="Ask an organization owner to review access." />);
  expect(locked).toContain('role="status"');
  expect(locked).toContain("lucide-lock-keyhole");
  expect(locked).not.toContain("lucide-info");
  expect(renderToStaticMarkup(<DenNotice message="Request failed" />)).toContain('role="alert"');
});
