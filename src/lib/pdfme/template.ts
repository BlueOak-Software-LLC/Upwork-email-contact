import rawSample from "../../../templates/pdfme/proposal-template.json";

/**
 * pdfme v6 template shape: `{ pdfmeVersion, basePdf, schemas: Field[][] }`,
 * where `schemas` is one entry **per page** and each page lists its fields.
 * All geometry is **millimetres** (pdfme converts mm→pt; A4 = 210×297).
 *
 * At runtime the proposal template is **generated per document** by
 * `compiler.ts` (`compileProposalPdfme`) — content drives the layout, so the
 * proposal can be any length. The JSON imported here is the *reference copy*
 * of one compiled document: import it into https://pdfme.com/template-design to
 * inspect or re-style the geometry, and keep `PDFME_TEMPLATE_PATH` pointing at
 * it.
 */
export type PdfmeField = {
  name: string;
  type: string;
  content?: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  fontSize?: number;
  fontColor?: string;
  backgroundColor?: string;
  alignment?: "left" | "center" | "right" | "justify";
  verticalAlignment?: "top" | "middle" | "bottom";
  lineHeight?: number;
  characterSpacing?: number;
  dynamicFontSize?: { min: number; max: number; fit: "horizontal" | "vertical" };
  readOnly?: boolean;
  required?: boolean;
  [key: string]: unknown;
};

export type PdfmeTemplate = {
  pdfmeVersion?: string;
  basePdf: { width: number; height: number; padding: [number, number, number, number] };
  schemas: PdfmeField[][];
};

/** Compiled from `examples/ppd-example.json` — see README §5. */
export const sampleProposalTemplate = rawSample as unknown as PdfmeTemplate;

export const sampleFieldNames = sampleProposalTemplate.schemas.flat().map((f) => f.name);
