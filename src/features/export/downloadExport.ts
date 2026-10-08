import { exportFilename, type ExportDocument } from './dataExport'

/** Saves the export from the browser (Blob + anchor). Nothing is uploaded anywhere. */
export function downloadExport(doc: ExportDocument): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = exportFilename(new Date(doc.exported_at))
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
