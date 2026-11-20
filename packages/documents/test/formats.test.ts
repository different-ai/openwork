import assert from "node:assert/strict"
import { test } from "node:test"
import { buildZip, openXlsxWorkbook, utf8Bytes } from "@openwork/workbook"
import { officeFormats, officeFileTypeSchema, nativeOfficeFormats } from "../src/office-engine"
import { validateOfficePackage } from "../src/office-server"
import { collaboraCommand } from "../src/collabora-controller"

test("each supported format keeps its own editor kind and native Google Slides exports as PowerPoint", () => {
  assert.equal(nativeOfficeFormats["application/vnd.google-apps.presentation"], "pptx")
  for (const type of officeFileTypeSchema.options) assert.equal(officeFormats[type].kind, ["xlsx", "ods"].includes(type) ? "spreadsheet" : ["pptx", "odp"].includes(type) ? "presentation" : "document")
})

test("a presentation package cannot be substituted for a Word or Excel snapshot", async () => {
  const bytes = await buildZip([{ name: "ppt/presentation.xml", data: utf8Bytes("<presentation/>") }])
  await validateOfficePackage(bytes, "pptx")
  await assert.rejects(validateOfficePackage(bytes, "docx"), /different file format/)
  await assert.rejects(validateOfficePackage(bytes, "xlsx"), /different file format/)
  const macro = await buildZip([{ name: "ppt/presentation.xml", data: utf8Bytes("<presentation/>") }, { name: "ppt/vbaProject.bin", data: utf8Bytes("macro") }])
  await assert.rejects(validateOfficePackage(macro, "pptx"), /Macro-enabled/)
})

test("OpenDocument validates its MIME and rejects encryption, scripts and signatures", async () => {
  const create = (mime: string, content = "<office:document-content/>", extras: { name: string; data: Uint8Array }[] = []) => buildZip([
    { name: "mimetype", data: utf8Bytes(mime) }, { name: "content.xml", data: utf8Bytes(content) },
    { name: "META-INF/manifest.xml", data: utf8Bytes("<manifest/>") }, ...extras,
  ])
  for (const type of ["odt", "ods", "odp"]) {
    const format = officeFileTypeSchema.parse(type)
    await validateOfficePackage(await create(officeFormats[format].mimeType), format)
  }
  await assert.rejects(validateOfficePackage(await create(officeFormats.ods.mimeType), "odt"), /different OpenDocument/)
  await validateOfficePackage(await create(officeFormats.odt.mimeType, "<office:scripts/>"), "odt")
  for (const tag of ["manifest:encryption-data", "script:script", "script:event-listener"]) await assert.rejects(validateOfficePackage(await create(officeFormats.odt.mimeType, `<${tag}/>`), "odt"), /macros, encryption or event scripts/)
  await assert.rejects(validateOfficePackage(await create(officeFormats.odt.mimeType, "<office:scripts><other:code/></office:scripts>"), "odt"), /macros, encryption or event scripts/)
  await assert.rejects(validateOfficePackage(await create(officeFormats.odt.mimeType, "<!DOCTYPE content SYSTEM 'https://example.com/document.dtd'><content/>"), "odt"), /macros, encryption or event scripts/)
  await assert.rejects(validateOfficePackage(await create(officeFormats.odt.mimeType, "<\0s\0c\0r\0i\0p\0t\0/\0>\0"), "odt"), /UTF-8/)
  for (const path of ["Basic/Standard/module.xml", "Scripts/python/macro.py", "META-INF/documentsignatures.xml"]) await assert.rejects(validateOfficePackage(await create(officeFormats.odt.mimeType, undefined, [{ name: path, data: utf8Bytes("unsafe") }]), "odt"), /Macro-enabled/)
})

test("composed editor controls can only send bounded formatting commands", () => {
  assert.equal(collaboraCommand({ type: "action", action: "new-slide" }, "presentation").Command, ".uno:InsertPage")
  assert.equal(collaboraCommand({ type: "highlight", value: "#112233" }, "spreadsheet").Command, ".uno:BackgroundColor")
  assert.equal(collaboraCommand({ type: "slide-layout", value: "two-columns" }, "presentation").Args?.WhatLayout.value, 3)
  assert.throws(() => collaboraCommand({ type: "slide-layout", value: "title" }, "document"))
  assert.throws(() => collaboraCommand({ type: "font-size", value: Number.NaN }, "document"))
  assert.throws(() => collaboraCommand({ type: "font-size", value: 10000 }, "document"))
  assert.throws(() => collaboraCommand({ type: "color", value: "url(https://example.com)" }, "document"))
  assert.throws(() => collaboraCommand({ type: "table", rows: 10000, columns: 3 }, "document"))
  assert.throws(() => Reflect.apply(collaboraCommand, undefined, [{ type: "action", action: "constructor" }, "document"]))
})

test("elapsed-time cells read as durations, not 1900 dates", async () => {
  const styles = '<styleSheet><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="46"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs><numFmts count="1"><numFmt numFmtId="164" formatCode="[mm]:ss"/></numFmts></styleSheet>'
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>1.5</v></c><c r="B1" s="2"><v>0.0625</v></c><c r="C1" s="3"><v>45000</v></c></row></sheetData></worksheet>'
  const bytes = await buildZip([
    { name: "xl/workbook.xml", data: utf8Bytes('<workbook><sheets><sheet name="Hours" sheetId="1"/></sheets></workbook>') },
    { name: "xl/styles.xml", data: utf8Bytes(styles) },
    { name: "xl/worksheets/sheet1.xml", data: utf8Bytes(sheet) },
  ])
  const workbook = await openXlsxWorkbook(bytes)
  const { cells } = await workbook.readSheet(workbook.sheets[0]!)
  const shown = Object.fromEntries(cells.map((cell) => [cell.reference, cell.displayedValue]))
  // [h]:mm:ss shows 36 hours as 36:00:00 in Excel, not as 1900-01-01 12:00:00
  assert.equal(shown.A1, "36:00:00")
  assert.equal(shown.B1, "1:30:00")
  assert.equal(shown.C1, "2023-03-15")
})
