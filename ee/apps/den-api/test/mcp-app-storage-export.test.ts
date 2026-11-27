import assert from "node:assert/strict"
import { test } from "node:test"

import { buildMcpAppStorageCsv } from "../src/mcp-app-storage/csv.js"

test("CSV quotes values, emits CRLF, sorts former fields and neutralizes formulas", () => {
  const provenance = { created_by: "a", created_at: "then", updated_by: "b", updated_at: "now" }
  assert.equal(buildMcpAppStorageCsv(["text", "formula", "missing"], [{
    ...provenance,
    id: "a",
    owner: null,
    data: { text: 'déjà, "quoted"\nnew line', formula: "=SUM(1)", z: -3, a: null, b: "+1", c: "@x", d: "\tx", e: "\rx" },
  }, { ...provenance, id: "b", owner: "owner", data: { formula: false } }]), [
    "id,text,formula,missing,a,b,c,d,e,z,created_by,created_at,updated_by,updated_at,visibility,owner_member_id",
    `a,"déjà, ""quoted""\nnew line",'=SUM(1),,,'+1,'@x,'\tx,"'\rx",-3,a,then,b,now,shared,`,
    "b,,false,,,,,,,,a,then,b,now,personal,owner",
    "",
  ].join("\r\n"))
})

test("CSV neutralizes text formulas after whitespace or controls without altering numbers", () => {
  assert.equal(buildMcpAppStorageCsv(["spaces", "newline", "tab", "control", "number", "text"], [{
    id: "a", owner: null, created_by: "a", created_at: "then", updated_by: "b", updated_at: "now",
    data: { spaces: "  =SUM(1)", newline: "\n=1+1", tab: "\t@x", control: "\u0001+1", number: -5, text: "-5" },
  }]), [
    "id,spaces,newline,tab,control,number,text,created_by,created_at,updated_by,updated_at,visibility,owner_member_id",
    `a,'  =SUM(1),"'\n=1+1",'\t@x,'\u0001+1,-5,'-5,a,then,b,now,shared,`,
    "",
  ].join("\r\n"))
})

test("CSV preserves field names when they collide with metadata", () => {
  const fields = ["created_by", "created_at", "updated_by", "updated_at", "visibility", "owner_member_id"]
  assert.equal(buildMcpAppStorageCsv(fields, [{
    id: "a", owner: "member", created_by: "a", created_at: "then", updated_by: "b", updated_at: "now",
    data: Object.fromEntries(fields.map((key) => [key, `field_${key}`])),
  }]), [
    `id,${fields.join(",")},${fields.map((key) => `_${key}`).join(",")}`,
    `a,${fields.map((key) => `field_${key}`).join(",")},a,then,b,now,personal,member`,
    "",
  ].join("\r\n"))
})

test("CSV emits a header for an empty declared collection", () => {
  assert.equal(buildMcpAppStorageCsv(["value"], []), "id,value,created_by,created_at,updated_by,updated_at,visibility,owner_member_id\r\n")
})
