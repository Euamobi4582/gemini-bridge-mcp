# gemini-bridge-mcp

An **MCP server** that talks to the **logged-in Google Gemini web UI** through browser
automation — so any MCP client (Claude Code, Claude Desktop, …) can use Gemini
**without an API key**. It rides your existing Gemini subscription, exactly as if you
typed in the browser yourself.

## Tools

| Tool | What it does |
|---|---|
| **`ask_gemini`** | Ask a question. Multimodal (attach images / PDFs / video / audio by path). Pick the model. |
| **`generate_image`** | Generate an image with Gemini's image model (a.k.a. *Nano Banana*). Saves PNG(s). |
| **`generate_video`** | Generate a video with Gemini's video model (*Veo*). Saves an MP4. |

## How it works

Uses [`playwright-core`](https://playwright.dev) to drive your **installed** Chromium
browser (Chrome / Brave / Edge, auto-detected) against `gemini.google.com`, with a
**persistent profile** so you log in only once. No official API, no key — it uses your
normal Gemini quota.

- Images (`blob:` URLs) are read back via a `<canvas>` export (works around Gemini's fetch CSP).
- Videos (signed cross-origin URLs) are downloaded server-side with your session cookies.
- Conversation continuity: by default follow-up calls stay in the **same** Gemini chat
  (set `new_chat: true` to start fresh).

## Requirements

- **Node.js 18+**
- A **Chromium-based browser** installed (Chrome, Brave, or Edge)
- A Google account with access to Gemini

## Setup

```bash
npm install        # installs deps — NO browser download, it uses your installed one
npm run login      # one-time: a window opens, sign in to Google/Gemini
```

The login is stored in a local profile folder (`./.gemini-profile`, git-ignored).

## Use as an MCP server

Add it to your MCP client config (use an **absolute** path to `server.js`):

```json
{
  "mcpServers": {
    "gemini-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/gemini-bridge-mcp/server.js"],
      "env": { "GEMINI_HEADLESS": "1" }
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add gemini-bridge --env GEMINI_HEADLESS=1 -- node /absolute/path/to/server.js
```

## CLI (testing / maintenance)

```bash
node server.js login                          # one-time login window
node server.js check                          # is the profile logged in?
node server.js ask "your question"
node server.js ask --model=pro "your question"        # flash-lite | flash | pro
node server.js ask --file=/path/to/img.png "describe this"
node server.js image "a red sports car on a mountain road at sunset"
node server.js video "a slow drone shot over a turquoise lake"
node server.js dump                           # print button labels (selector maintenance)
node server.js http                           # run as a Streamable-HTTP MCP server
```

## `ask_gemini` parameters

| Param | Required | Description |
|---|---|---|
| `prompt` | yes | The question / instruction. |
| `files` | no | Absolute paths to attach (image / PDF / video / audio). |
| `model` | no | `flash-lite`, `flash`, or `pro`. |
| `new_chat` | no | `true` = start a fresh Gemini chat (default `false` = continue). |
| `timeout_seconds` | no | Max wait (default 180; raise for video). |

## Environment variables

| Variable | Effect |
|---|---|
| `GEMINI_HEADLESS=1` | Run invisibly (recommended for MCP use). |
| `GEMINI_BROWSER_PATH` | Explicit path to `chrome.exe` / `brave.exe` / `msedge.exe` if auto-detect misses. |
| `GEMINI_PROFILE_DIR` | Login profile folder (default `./.gemini-profile`). |
| `GEMINI_OUTPUT_DIR` | Where generated media is saved (default `./output`). |
| `GEMINI_PORT` | Port for HTTP mode (default `7801`). |
| `GEMINI_TLS_CERT` / `GEMINI_TLS_KEY` | Serve HTTP mode over **https** (e.g. a [mkcert](https://github.com/FiloSottile/mkcert) localhost cert). Defaults to `./certs/cert.pem` + `./certs/key.pem` if present. |
| `GEMINI_DEBUG=1` | Debug screenshots (`debug-*.png`) + DOM dumps. |

## HTTP / remote mode

`node server.js http` serves a **Streamable HTTP** MCP endpoint at
`http://localhost:7801/mcp` (CORS enabled). Drop `cert.pem` / `key.pem` into `./certs/`
(or set `GEMINI_TLS_CERT` / `GEMINI_TLS_KEY`) to serve it over `https`.

## ⚠️ Locale note (important)

Some selectors match the **German** Gemini UI (e.g. `Dateien hochladen`,
`Bild erstellen`, `Video erstellen`, `Modusauswahl öffnen`, `Jetzt ausprobieren`).
If your Gemini is in another language, edit the marked values in the `SEL` object
(and the `Jetzt ausprobieren` regex) in `server.js` to the matching labels —
for English that's `Upload files`, `Create image`, `Create video`, etc.
`node server.js dump` prints the current button labels to help.

## Maintenance

Because this drives the **web UI**, Google's UI changes can break the selectors. They
all live in the `SEL` object near the top of `server.js`. Run `node server.js dump` to
print the current button labels and fix them.

## ⚠️ Disclaimer

This automates the Gemini **web interface** of **your own** account. It uses **no official
API**. Automating Google's web UI may violate Google's Terms of Service — **use at your own
risk, for personal use only**. Don't be surprised if a UI change breaks it, or if heavy
automated use gets your account rate-limited or flagged. Provided **"as is"**, without
warranty. Not affiliated with Google or Anthropic. "Gemini", "Nano Banana" and "Veo" are
products/trademarks of Google.

## Acknowledgements

Designed and coded with the help of **[Claude Code](https://claude.com/claude-code)**
(Anthropic's **Claude Opus 4.8**, with extended thinking) — from reverse-engineering the
Gemini web UI selectors to the image/video extraction and the MCP wiring.

## License

[MIT](LICENSE)
