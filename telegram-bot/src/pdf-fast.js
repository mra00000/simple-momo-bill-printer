// Minimal PDF writer that never decodes pixels.
//
// PDF can hold JPEG data as-is (/DCTDecode), and PNG pixel data as-is too
// (/FlateDecode with PNG predictors), so building the file is just reading a
// few header bytes and concatenating buffers. That keeps CPU time far below
// the Workers Free plan's 10 ms limit.
//
// Not handled here (parseImage returns null → caller falls back to pdf-lib):
// PNGs with transparency (alpha channel or tRNS) or interlacing, since those
// need the pixels decoded.

import { detectFormat, placeOnPage, PAGE_SIZE, PAGE_MATRIX, PER_PAGE } from "./layout.js";

const enc = new TextEncoder();
const num = (v) => String(+v.toFixed(3));

/**
 * @returns {{width: number, height: number, data: Uint8Array, dict: string} | null}
 *   null if the image needs the slow path
 */
export function parseImage(bytes) {
  const format = detectFormat(bytes);
  if (format === "jpeg") return parseJpeg(bytes);
  if (format === "png") return parsePng(bytes);
  return null;
}

function parseJpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers without length
    if (m === 0xd9 || m === 0xda) return null; // end / scan data before any SOF
    // SOFn markers (C4 = DHT, C8 = JPG, CC = DAC are not frames)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const bpc = b[i + 4];
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      const comps = b[i + 9];
      const cs = { 1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK" }[comps];
      if (!cs || !width || !height) return null;
      let dict = `/Width ${width} /Height ${height} /ColorSpace ${cs} /BitsPerComponent ${bpc} /Filter /DCTDecode`;
      if (comps === 4) dict += " /Decode [1 0 1 0 1 0 1 0]"; // Adobe CMYK JPEGs are stored inverted
      return { width, height, data: b, dict };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

function parsePng(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let ihdr = null;
  let plte = null;
  let trns = false;
  const idat = [];
  let i = 8;
  while (i + 8 <= b.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const start = i + 8;
    const end = start + len;
    if (end > b.length) return null;
    if (type === "IHDR") {
      ihdr = {
        width: dv.getUint32(start),
        height: dv.getUint32(start + 4),
        depth: b[start + 8],
        color: b[start + 9],
        interlace: b[start + 12],
      };
    } else if (type === "PLTE") plte = b.subarray(start, end);
    else if (type === "tRNS") trns = true;
    else if (type === "IDAT") idat.push(b.subarray(start, end));
    else if (type === "IEND") break;
    i = end + 4; // skip CRC
  }
  if (!ihdr || ihdr.interlace || trns || !idat.length) return null;

  const { width, height, depth, color } = ihdr;
  let cs;
  let colors;
  if (color === 0) { cs = "/DeviceGray"; colors = 1; }
  else if (color === 2) { cs = "/DeviceRGB"; colors = 3; }
  else if (color === 3 && plte) {
    cs = `[/Indexed /DeviceRGB ${plte.length / 3 - 1} <${toHex(plte)}>]`;
    colors = 1;
  } else return null; // 4 = gray+alpha, 6 = RGBA

  return {
    width,
    height,
    data: idat.length === 1 ? idat[0] : concat(idat),
    dict:
      `/Width ${width} /Height ${height} /ColorSpace ${cs} /BitsPerComponent ${depth} /Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${depth} /Columns ${width} >>`,
  };
}

/**
 * @param {ReturnType<typeof parseImage>[]} images  all non-null, in print order
 * @returns {Uint8Array}
 */
export function writePdf(images) {
  const parts = [];
  const offsets = [];
  let offset = 0;
  const push = (x) => {
    const u = typeof x === "string" ? enc.encode(x) : x;
    parts.push(u);
    offset += u.length;
  };
  const obj = (id, dict, stream) => {
    offsets[id] = offset;
    if (stream) {
      push(`${id} 0 obj\n<< ${dict} /Length ${stream.length} >>\nstream\n`);
      push(stream);
      push("\nendstream\nendobj\n");
    } else {
      push(`${id} 0 obj\n${dict}\nendobj\n`);
    }
  };

  // Object ids: 1 catalog, 2 page tree, 3 info, then images, then pages + contents
  let nextId = 4;
  const imageIds = images.map(() => nextId++);
  const pages = [];
  for (let start = 0; start < images.length; start += PER_PAGE) {
    pages.push({ start, end: Math.min(start + PER_PAGE, images.length), id: nextId++, contentId: nextId++ });
  }

  push(new Uint8Array([...enc.encode("%PDF-1.5\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((p) => `${p.id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  obj(3, "<< /Title (MoMo bills) /Producer (momo-bill-printer-bot) >>");
  images.forEach((img, k) => obj(imageIds[k], `/Type /XObject /Subtype /Image ${img.dict}`, img.data));

  for (const page of pages) {
    const chunk = images.slice(page.start, page.end);
    const rects = placeOnPage(chunk);
    let content = PAGE_MATRIX ? `q ${PAGE_MATRIX.map(num).join(" ")} cm\n` : "";
    rects.forEach((r, j) => {
      content += `q ${num(r.w)} 0 0 ${num(r.h)} ${num(r.x)} ${num(r.y)} cm /Im${j} Do Q\n`;
    });
    if (PAGE_MATRIX) content += "Q\n";
    const xobjects = chunk.map((_, j) => `/Im${j} ${imageIds[page.start + j]} 0 R`).join(" ");

    obj(page.contentId, "", enc.encode(content));
    obj(
      page.id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_SIZE[0])} ${num(PAGE_SIZE[1])}] ` +
        `/Resources << /XObject << ${xobjects} >> >> /Contents ${page.contentId} 0 R >>`,
    );
  }

  const xrefAt = offset;
  let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id++) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${nextId} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return concat(parts, offset);
}

function concat(parts, total = parts.reduce((s, p) => s + p.length, 0)) {
  const out = new Uint8Array(total);
  let p = 0;
  for (const u of parts) {
    out.set(u, p);
    p += u.length;
  }
  return out;
}

function toHex(bytes) {
  let s = "";
  for (const v of bytes) s += v.toString(16).padStart(2, "0");
  return s;
}
