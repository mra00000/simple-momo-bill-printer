import { parseImage, writePdf } from "./pdf-fast.js";

/**
 * @param {Uint8Array[]} images  JPEG or PNG bytes, in print order
 * @returns {Promise<{bytes: Uint8Array, engine: "fast" | "pdf-lib"}>}
 */
export async function buildPdf(images) {
  const parsed = images.map(parseImage);
  if (parsed.every(Boolean)) return { bytes: writePdf(parsed), engine: "fast" };

  // Some PNG needs decoding: use pdf-lib, loaded only now.
  const { buildWithPdfLib } = await import("./pdf-lib-fallback.js");
  return { bytes: await buildWithPdfLib(images), engine: "pdf-lib" };
}
