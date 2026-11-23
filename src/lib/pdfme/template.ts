import rawTemplate from "../../../templates/pdfme/proposal-template.json";

/**
 * pdfme v6 template used to render the PPD.
 *
 * Shape (v6): `{ pdfmeVersion, basePdf, schemas: SchemaItem[][] }` where
 * `schemas` is one entry **per page** and each page lists its fields
 * (`{ name, type, content, position:{x,y}, width, height, fontSize, … }`).
 * All geometry is **millimetres** (pdfme converts mm→pt internally; A4 = 210×297).
 *
 * Edit visually at https://pdfme.com/template-design and replace this file —
 * field **names** are the contract (see `mapper.ts`); geometry is free.
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
  alignment?: "left" | "center" | "right";
  lineHeight?: number;
  characterSpacing?: number;
  readOnly?: boolean;
  [key: string]: unknown;
};

export type PdfmeTemplate = {
  pdfmeVersion?: string;
  basePdf: { width: number; height: number; padding: [number, number, number, number] };
  schemas: PdfmeField[][];
};

export const proposalTemplate = rawTemplate as unknown as PdfmeTemplate;

export const proposalTemplateFieldNames = proposalTemplate.schemas.flat().map((f) => f.name);

/** Static captions baked into the template — the mapper must not overwrite them. */
export const staticFieldNames = proposalTemplate.schemas
  .flat()
  .filter((f) => f.readOnly)
  .map((f) => f.name);
