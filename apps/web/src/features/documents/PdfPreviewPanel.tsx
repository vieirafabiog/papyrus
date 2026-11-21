import { DocumentPreviewPanel, type DocumentPreviewPanelProps } from "./DocumentPreviewPanel.js";

export type PdfPreviewPanelProps = DocumentPreviewPanelProps;

/**
 * Backward-compatible alias delegating to the unified DocumentPreviewPanel.
 */
export function PdfPreviewPanel(props: PdfPreviewPanelProps) {
  return <DocumentPreviewPanel {...props} />;
}
