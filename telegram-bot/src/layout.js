// Page layout, same as index.html prints it:
//   - A4, 3 images per page
//   - each image gets a slot 1/3 of the (landscape) page wide and full height
//   - the image is scaled to fit its slot without cropping (object-fit: contain)
//     and centred in it
//   - slots are spread with `justify-content: space-between`, so a page with
//     2 images puts them at the left and right edges, like the web page does
//   - like the @media print rule `transform: rotate(90deg) translate(43mm, 43mm)`,
//     the landscape layout is rotated 90° clockwise onto a portrait A4 sheet
//     (image #1 at the top). The CSS's 43mm is a rounded (297-210)/2 = 43.5mm,
//     so the browser output sits 0.5mm off; here it fits the sheet exactly.
//     The rotation is a single PDF transform matrix, so it costs no CPU.

export const PER_PAGE = 3;
// Set to false to get plain landscape pages instead of rotated portrait sheets.
export const ROTATE_TO_PORTRAIT = true;

export const A4_W = 841.89; // 297 mm in PDF points (layout is designed in landscape)
export const A4_H = 595.28; // 210 mm

/** [width, height] of each PDF page. */
export const PAGE_SIZE = ROTATE_TO_PORTRAIT ? [A4_H, A4_W] : [A4_W, A4_H];

/**
 * PDF transform applied to the whole page before drawing, or null.
 * Maps landscape coords (x, y) to portrait (y, A4_W - x): a 90° clockwise turn,
 * so the landscape's left edge becomes the sheet's top edge.
 */
export const PAGE_MATRIX = ROTATE_TO_PORTRAIT ? [0, -1, 1, 0, 0, A4_W] : null;

/**
 * Where to draw each image of one page, in landscape PDF coordinates.
 * @param {{width: number, height: number}[]} sizes  1..PER_PAGE image sizes
 * @returns {{x: number, y: number, w: number, h: number}[]}
 */
export function placeOnPage(sizes) {
  const slotW = A4_W / PER_PAGE;
  return sizes.map(({ width, height }, j) => {
    // space-between: first slot at the left edge, last at the right edge
    const slotX = sizes.length === 1 ? 0 : (j * (A4_W - slotW)) / (sizes.length - 1);
    // contain
    const scale = Math.min(slotW / width, A4_H / height);
    const w = width * scale;
    const h = height * scale;
    return { x: slotX + (slotW - w) / 2, y: (A4_H - h) / 2, w, h };
  });
}

/** Returns "jpeg", "png", or null by checking the file's magic bytes. */
export function detectFormat(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}
