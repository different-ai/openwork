import { FileSpreadsheet, FileText, Folder, Image, Presentation } from "lucide-react"
import { documentType, type DocumentItem } from "./index"

/** One icon per kind of file, the same in the listing, the sidebar and the open tabs. */
export function ItemIcon({ item, size = 20 }: { item: DocumentItem; size?: number }) {
  const type = documentType(item)
  const Icon = item.kind === "folder" ? Folder : /Sheets|Excel|CSV|spreadsheet/.test(type) ? FileSpreadsheet : /Slides|PowerPoint|presentation/.test(type) ? Presentation : type === "Image" ? Image : FileText
  return <Icon className="ow-documents-item-icon" data-kind={type} size={size} strokeWidth={1.5} aria-hidden />
}
