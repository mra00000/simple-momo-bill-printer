// Slow path, used only when an image can't be embedded without decoding
// (PNG with transparency or interlacing). Loaded on demand from pdf.js.

import { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "pdf-lib";
import { detectFormat, placeOnPage, PAGE_SIZE, PAGE_MATRIX, PER_PAGE } from "./layout.js";

/** @param {Uint8Array[]} images  JPEG or PNG bytes, in print order */
export async function buildWithPdfLib(images) {
  const pdf = await PDFDocument.create();
  pdf.setTitle("MoMo bills");
  pdf.setProducer("momo-bill-printer-bot");

  for (let start = 0; start < images.length; start += PER_PAGE) {
    const chunk = [];
    for (const bytes of images.slice(start, start + PER_PAGE)) {
      chunk.push(detectFormat(bytes) === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes));
    }
    const page = pdf.addPage(PAGE_SIZE);
    if (PAGE_MATRIX) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...PAGE_MATRIX));
    placeOnPage(chunk).forEach((r, j) => page.drawImage(chunk[j], { x: r.x, y: r.y, width: r.w, height: r.h }));
    if (PAGE_MATRIX) page.pushOperators(popGraphicsState());
  }

  return pdf.save();
}
