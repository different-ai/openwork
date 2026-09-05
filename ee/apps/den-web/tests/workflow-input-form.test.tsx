import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { formFieldsFromSchema, WorkflowInputForm } from "../app/(den)/dashboard/_components/workflow-input-form";

const schema = {
  type: "object",
  properties: {
    query: { type: "string", title: "Search query" },
    channel: { type: "string", enum: ["support", "sales"] },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    includeArchived: { type: "boolean", description: "Include archived results" },
  },
  required: ["query", "limit"],
};

describe("Workflow input form", () => {
  test("builds controls for supported object properties", () => {
    const fields = formFieldsFromSchema(schema);

    expect(fields?.map((field) => [field.key, field.kind, field.options])).toEqual([
      ["query", "string", null],
      ["channel", "string", ["support", "sales"]],
      ["limit", "integer", null],
      ["includeArchived", "boolean", null],
    ]);

    const markup = renderToStaticMarkup(createElement(WorkflowInputForm, { schema, value: {}, onChange: () => undefined }));
    expect(markup.match(/<select/g)).toHaveLength(1);
    expect(markup).toContain('type="text"');
    expect(markup).toContain('type="number"');
    expect(markup).toContain('type="checkbox"');
  });

  test("rejects schemas with unsupported array properties", () => {
    expect(formFieldsFromSchema({ type: "object", properties: { tags: { type: "array", items: { type: "string" } } } })).toBeNull();
  });

  test("renders field markers and required controls", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowInputForm, { schema, value: {}, onChange: () => undefined }));

    expect(markup).toContain('data-testid="den-workflow-input-form"');
    for (const key of ["query", "channel", "limit", "includeArchived"]) expect(markup).toContain(`data-field="${key}"`);
    expect(markup.match(/required=""/g)).toHaveLength(2);
    expect(markup).toContain("Search query *");
  });
});
