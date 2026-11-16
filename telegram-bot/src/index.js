// Telegram bot on Cloudflare Workers: send it bill screenshots, get back a
// printable PDF (3 bills per A4 page, same layout as index.html).
//
// Flow:
//   Telegram --webhook--> Worker fetch()  --> ChatSession Durable Object (one per chat)
//   The Durable Object queues the images. A few seconds after the last image
//   arrives (so a whole album is collected), its alarm fires, builds the PDF and
//   sends it back to the chat.

import { DurableObject } from "cloudflare:workers";
import { detectFormat, PER_PAGE } from "./layout.js";
import { buildPdf } from "./pdf.js";

// If a print run dies without reaching our catch block (e.g. Cloudflare kills it
// for exceeding the CPU limit), a watchdog alarm fires after this long and
// tells the user. Telegram calls time out well before it (see TG_TIMEOUT_MS).
const WATCHDOG_MS = 2 * 60 * 1000;
const TG_TIMEOUT_MS = 30 * 1000;
const MAX_ATTEMPTS = 2;

const HELP = [
  "🧾 Gửi ảnh hoá đơn MoMo cho mình (gửi lẻ hoặc gửi cả album).",
  "Mình sẽ ghép 3 ảnh vào mỗi trang A4 và trả về file PDF để in.",
  "",
  "/print – in ngay các ảnh đang chờ",
  "/clear – xoá các ảnh đang chờ",
  "",
  "Mẹo: gửi ảnh dạng File (không nén) để bản in nét hơn.",
].join("\n");

// ---------------------------------------------------------------------------
// Worker: receives Telegram webhook updates
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    // Only accept requests that Telegram signs with our secret.
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    // Always answer 200, otherwise Telegram keeps retrying the same update.
    try {
      const update = await request.json();
      await handleUpdate(update, env);
    } catch (err) {
      console.error("handleUpdate failed", err);
    }
    return new Response("OK");
  },
};

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (!isAllowed(msg.from?.id, env)) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⛔ Bạn không có quyền dùng bot này." });
    return;
  }

  const session = env.CHAT.get(env.CHAT.idFromName(String(chatId)));

  // Commands
  if (msg.text) {
    const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
    if (cmd === "/print") {
      const n = await session.printNow();
      if (!n) await tg(env, "sendMessage", { chat_id: chatId, text: "Chưa có ảnh nào đang chờ." });
    } else if (cmd === "/clear") {
      const n = await session.clear();
      await tg(env, "sendMessage", { chat_id: chatId, text: `🗑 Đã xoá ${n} ảnh.` });
    } else {
      await tg(env, "sendMessage", { chat_id: chatId, text: HELP });
    }
    return;
  }

  // Images: compressed photo, or an uncompressed JPEG/PNG sent as a file
  let fileId = null;
  if (msg.photo?.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
  } else if (msg.document) {
    const type = msg.document.mime_type || "";
    if (type === "image/jpeg" || type === "image/png") {
      fileId = msg.document.file_id;
    } else {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        reply_to_message_id: msg.message_id,
        text: "⚠️ Chỉ hỗ trợ ảnh JPG hoặc PNG.",
      });
      return;
    }
  }

  if (fileId) {
    await session.add({ chatId, messageId: msg.message_id, fileId });
  }
}

function isAllowed(userId, env) {
  const list = (env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(String(userId));
}

// ---------------------------------------------------------------------------
// Durable Object: one per chat, queues images and prints them
// ---------------------------------------------------------------------------

export class ChatSession extends DurableObject {
  get delayMs() {
    const s = Number(this.env.AUTO_PRINT_DELAY_SECONDS ?? 4);
    return Number.isFinite(s) && s >= 0 ? s * 1000 : 4000;
  }

  async pending() {
    return (await this.ctx.storage.get("pending")) || [];
  }

  /** Queue an image and (re)start the "quiet period" timer. */
  async add(item) {
    const list = await this.pending();
    list.push(item);
    await this.ctx.storage.put("pending", list);
    // Each new image pushes the alarm back, so an album is printed as one PDF.
    await this.ctx.storage.setAlarm(Date.now() + Math.max(this.delayMs, 1500));
    return list.length;
  }

  /** Print right away (runs in the alarm so the webhook returns quickly). */
  async printNow() {
    const list = await this.pending();
    if (!list.length) return 0;
    await this.ctx.storage.put("forcePrint", true);
    await this.ctx.storage.setAlarm(Date.now());
    return list.length;
  }

  async clear() {
    const list = await this.pending();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return list.length;
  }

  async alarm() {
    const list = await this.pending();
    if (!list.length) {
      await this.ctx.storage.delete("attempts");
      return;
    }
    const chatId = list[0].chatId;
    const force = await this.ctx.storage.get("forcePrint");
    const attempts = (await this.ctx.storage.get("attempts")) || 0;

    // A previous run started but never finished: it was killed by the platform.
    if (attempts >= MAX_ATTEMPTS) {
      await tg(this.env, "sendMessage", {
        chat_id: chatId,
        text:
          `❌ Không tạo được file in sau ${attempts} lần thử (có thể do vượt giới hạn CPU của Cloudflare). ` +
          `Đã bỏ ${list.length} ảnh, hãy gửi lại ít ảnh hơn mỗi lần.`,
      });
      await this.finish(list);
      return;
    }
    if (attempts > 0) {
      await tg(this.env, "sendMessage", { chat_id: chatId, text: "⚠️ Lần tạo file trước bị lỗi, đang thử lại…" });
    }

    // Manual mode (AUTO_PRINT_DELAY_SECONDS = 0): just tell the user what's queued.
    if (this.delayMs === 0 && !force) {
      await tg(this.env, "sendMessage", {
        chat_id: chatId,
        text: `📥 ${list.length} ảnh đang chờ (${Math.ceil(list.length / PER_PAGE)} trang). Gửi /print để in.`,
      });
      return;
    }

    // Mark the run as started and arm the watchdog. If this run is killed, the
    // watchdog alarm (or Cloudflare's own alarm retry) sees attempts > 0.
    await this.ctx.storage.put("attempts", attempts + 1);
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);

    try {
      // Durable Objects hold outgoing requests until earlier storage writes are
      // saved, so once this call returns the watchdog is guaranteed to be armed.
      await tg(this.env, "sendChatAction", { chat_id: chatId, action: "upload_document" });
      await this.print(chatId, list);
    } catch (err) {
      console.error("print failed", err);
      await tg(this.env, "sendMessage", { chat_id: chatId, text: `❌ Lỗi khi tạo file in: ${err.message}` }).catch(
        () => {},
      );
    }
    await this.finish(list);
  }

  /** Drop the handled images and disarm the watchdog (or re-arm for newer images). */
  async finish(list) {
    // Remove only what we just handled; images that arrived meanwhile stay queued.
    const done = new Set(list.map((i) => i.messageId));
    const rest = (await this.pending()).filter((i) => !done.has(i.messageId));
    await this.ctx.storage.put("pending", rest);
    await this.ctx.storage.delete(["forcePrint", "attempts"]);
    if (rest.length) await this.ctx.storage.setAlarm(Date.now() + Math.max(this.delayMs, 1500));
    else await this.ctx.storage.deleteAlarm();
  }

  async print(chatId, list) {
    // Telegram may deliver album items out of order; message_id is send order.
    const items = [...list].sort((a, b) => a.messageId - b.messageId);

    const files = await Promise.all(items.map((i) => downloadFile(this.env, i.fileId)));
    const images = files.filter((b) => detectFormat(b) !== null);
    const skipped = files.length - images.length;
    if (!images.length) throw new Error("không có ảnh JPG/PNG hợp lệ");

    const t0 = Date.now();
    const { bytes: pdf, engine } = await buildPdf(images);
    console.log(`built PDF: ${images.length} images, ${pdf.length} bytes, engine=${engine}, ${Date.now() - t0} ms`);
    const pages = Math.ceil(images.length / PER_PAGE);

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      "caption",
      `🧾 ${images.length} ảnh · ${pages} trang A4` + (skipped ? ` · bỏ qua ${skipped} file lỗi` : ""),
    );
    form.append("document", new Blob([pdf], { type: "application/pdf" }), fileName());
    await tg(this.env, "sendDocument", form);
  }
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

/**
 * fetch() + read the body, aborted after TG_TIMEOUT_MS. Uses a timer that is
 * cleared as soon as we're done: AbortSignal.timeout() leaves its timer running,
 * which kept every alarm alive for the full 30 s (wallTime ~31 s).
 */
async function fetchWithTimeout(url, init, read) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${TG_TIMEOUT_MS / 1000}s`)), TG_TIMEOUT_MS);
  try {
    return await read(await fetch(url, { ...init, signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function tg(env, method, body) {
  const isForm = body instanceof FormData;
  const data = await fetchWithTimeout(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
    },
    (res) => res.json(),
  );
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

async function downloadFile(env, fileId) {
  const file = await tg(env, "getFile", { file_id: fileId });
  return fetchWithTimeout(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {}, async (res) => {
    if (!res.ok) throw new Error(`tải ảnh thất bại (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  });
}

function fileName() {
  // e.g. hoa-don-momo-2026-11-16-1432.pdf (Vietnam time)
  const d = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
  return `hoa-don-momo-${d.slice(0, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}.pdf`;
}
