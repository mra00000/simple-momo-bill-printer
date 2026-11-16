# MoMo bill printer: Telegram bot

You send bill screenshots to a Telegram bot. It sends back a **PDF**: 3 bills per A4 page,
laid out like [`index.html`](../index.html) prints it (portrait A4 sheet with the landscape layout
turned 90° clockwise, each bill fit into one-third of the page, nothing cropped).

You can send photos one at a time or as an album. About 4 seconds after the last image
arrives, the bot builds one PDF from all of them and sends it to you.

| Command  | What it does                         |
| -------- | ------------------------------------ |
| `/print` | Print everything queued right now     |
| `/clear` | Throw away the queued images          |
| `/start` | Show help                             |

> **Tip:** to get the sharpest print, send images **as a file**: tap 📎 → *File*. If you send
> them as normal photos, Telegram compresses them first.

## Why a PDF and not a PNG?

A PDF with real A4 pages prints at the correct size from any phone or computer. Workers
also has no canvas, so building a PNG would mean decoding and re-encoding every pixel
with WebAssembly. That is slow and runs into Worker CPU limits. With a PDF, the bot
places the original JPEG/PNG bytes on the page unchanged. That is fast, and the print is
exactly as sharp as the image you sent.

---

## Setup guide

You need about 10 minutes. You also need a free Cloudflare account and a Telegram account.

### 1. Install Node.js

On macOS, download the LTS installer from <https://nodejs.org>. Or, if you use Homebrew:

```sh
brew install node
```

Check that it worked: `node -v` should print v20 or newer.

### 2. Create the bot in Telegram

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a display name and a username (the username must end in `bot`).
3. BotFather replies with a **token** like `123456789:AAH...`. Keep this token private.
4. Optional: send `/setcommands` to BotFather, pick your bot, and paste:
   ```
   print - In ngay các ảnh đang chờ
   clear - Xoá các ảnh đang chờ
   ```

### 3. Find your Telegram user ID (recommended)

Message **@userinfobot**. It replies with your numeric ID, for example `987654321`. You use
it in step 5 so that only you can use the bot.

### 4. Install dependencies and log in to Cloudflare

```sh
cd telegram-bot
npm install
npx wrangler login      # opens a browser to log in to Cloudflare
```

### 5. Configure

Open `wrangler.jsonc` and set `ALLOWED_USER_IDS` to your ID from step 3. To allow more
than one person, separate the IDs with commas: `"987654321,123123123"`.

Then store the two secrets. Wrangler prompts you for each value:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN   # paste the BotFather token
npx wrangler secret put WEBHOOK_SECRET       # paste any long random string
```

To generate a random string for `WEBHOOK_SECRET`, run `openssl rand -hex 32`. Keep the
value, because you need it again in step 7.


> If `secret put` says the Worker doesn't exist yet, run step 6 first, then come back and
> run these two commands again.

### 6. Deploy

```sh
npm run deploy
```

At the end, Wrangler prints your Worker URL, like
`https://momo-bill-printer-bot.<your-subdomain>.workers.dev`.
### 7. Point Telegram at your Worker

Replace the three placeholders and run:

```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://momo-bill-printer-bot.<your-subdomain>.workers.dev" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message"]'
```

You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 8. Try it

Open your bot in Telegram, send `/start`, then send 4 or 5 bill screenshots. A few seconds
later you get `hoa-don-momo-….pdf`. Open it and print it on A4.

---

## Settings

All of these are in `wrangler.jsonc` under `vars`. Run `npm run deploy` after you change one.

- `AUTO_PRINT_DELAY_SECONDS` (default `4`): how long the bot waits after the last image
  before it prints. If your albums sometimes arrive as two PDFs, raise it. Set it to `"0"`
  to turn auto-print off. The bot then only reports how many images are queued, and
  prints when you send `/print`.
- `ALLOWED_USER_IDS`: the user IDs allowed to use the bot, separated by commas. Leave it
  empty to let anyone use it.

## Troubleshooting

- **The bot doesn't reply.** Run
  `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` and look at
  `last_error_message`. A `403` there means the `secret_token` you used in step 7 doesn't
  match `WEBHOOK_SECRET`. Set one of them again so they match.
- **Live logs:** run `npm run logs`, then send the bot a message.
- **"Exceeded CPU time limit" in the logs, or the bot says "Không tạo được file in".**
  The Workers Free plan allows 10 ms of CPU per run. Photos and most PNG files are copied
  into the PDF without decoding, which takes well under 1 ms. PNG files with transparency
  are the exception: they need decoding through pdf-lib, which can take hundreds of ms.
  Look for `engine=pdf-lib` in the logs. Send those images as normal photos, or switch to
  the Workers Paid plan ($5/month).
- **If a run is killed** (for example for going over the CPU limit), the bot notices
  within about 2 minutes and tries once more. If that fails too, it tells you in the chat
  and drops that batch.
- **A bill is printed sideways.** Some photos sent as files store their rotation in EXIF
  data, and the PDF ignores it. Send those as normal photos, or rotate them before sending.

## How it works

```
Telegram ──webhook──▶ Worker (src/index.js)
                          │  checks the secret header and the user allowlist
                          ▼
                ChatSession Durable Object (one per chat)
                          │  queues image file_ids; each new image pushes the alarm back
                          ▼  alarm fires after the quiet period (or /print)
              downloads the images → buildPdf() (src/pdf.js) → sendDocument
```

- `src/layout.js` holds the page layout. It is a direct port of the CSS in `index.html`.
  To change how many bills go on each page, change `PER_PAGE` there.
- `src/pdf-fast.js` is a small PDF writer. It copies JPEG data and PNG pixel data into
  the PDF without decoding them. `src/pdf-lib-fallback.js` is used only for PNG files
  with transparency or interlacing, and is loaded only when one arrives.
- The Durable Object is there so that every image in an album lands in the same queue.
  Telegram delivers an album as several separate webhook calls, so without one shared
  queue an album could be split up. Images are sorted by message ID, so the PDF follows
  the order you sent them in.
