import assert from "node:assert/strict"
import { test } from "node:test"
import { buildZip, extractOfficeText, openXlsxWorkbook, utf8Bytes } from "@openwork/workbook"

const sharedStrings = [
  '<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>',
  '<si><r><t>課</t></r><r><rPr><b/></rPr><t>長</t></r><rPh sb="0" eb="1"><t>カ</t></rPh><rPh sb="1" eb="2"><t>チョウ</t></rPh></si>',
  '<x:si><x:t>京都</x:t><x:rPh sb="0" eb="2"><x:t>キョウト</x:t></x:rPh></x:si>',
  "<si><t>Plain</t></si>",
  '<si><rPh sb="0" eb="2"/><t>奈良</t><rPh sb="0" eb="2"><t>ナラ</t></rPh></si>',
]
const inline = '<c r="F1" t="inlineStr"><is><t>大阪</t><rPh sb="0" eb="2"><t>オオサカ</t></rPh></is></c>'

async function workbookBytes() {
  const cells = sharedStrings.map((_, index) => `<c r="${String.fromCharCode(65 + index)}1" t="s"><v>${index}</v></c>`).join("")
  return buildZip([
    { name: "xl/workbook.xml", data: utf8Bytes('<workbook><sheets><sheet name="Offices" sheetId="1"/></sheets></workbook>') },
    { name: "xl/sharedStrings.xml", data: utf8Bytes(`<sst>${sharedStrings.join("")}</sst>`) },
    { name: "xl/worksheets/sheet1.xml", data: utf8Bytes(`<worksheet><sheetData><row r="1">${cells}${inline}</row></sheetData></worksheet>`) },
  ])
}

test("cell text leaves out the phonetic reading stored beside it", async () => {
  const workbook = await openXlsxWorkbook(await workbookBytes())
  const sheet = await workbook.readSheet(workbook.sheets[0])
  assert.deepEqual(sheet.cells.map((cell) => cell.displayedValue), ["東京", "課長", "京都", "Plain", "奈良", "大阪"])
})

test("the text an agent reads from an attached workbook has no phonetic readings", async () => {
  const text = await extractOfficeText("xlsx", await workbookBytes())
  assert.match(text, /東京/)
  assert.doesNotMatch(text, /トウキョウ|チョウ|キョウト|ナラ|オオサカ/)
})
