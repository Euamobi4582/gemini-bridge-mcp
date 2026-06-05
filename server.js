#!/usr/bin/env node
/**
 * gemini-bridge-mcp
 * -----------------
 * Ein MCP-Server, der mit deiner EINGELOGGTEN Gemini-Weboberflaeche
 * (gemini.google.com) per Browser-Automation spricht. Kein API-Key,
 * keine API-Kosten -- alles laeuft ueber dein Google-AI-Pro-Abo,
 * genau so als wuerdest du selbst tippen.
 *
 * Nutzt dein installiertes Chrome (playwright-core, channel: "chrome")
 * und ein eigenes, persistentes Login-Profil unter ./.gemini-profile,
 * damit der Login nur EINMAL noetig ist.
 *
 * Modi:
 *   node server.js login        -> Fenster oeffnen, einmalig einloggen
 *   node server.js ask "Frage"  -> Schnelltest auf der Kommandozeile
 *   node server.js              -> als MCP-Server ueber stdio (fuer Claude Code)
 */

import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Chromium-Binary finden (Chrome ist hier nicht installiert -> Brave/Edge).
// Reihenfolge: explizit gesetzt -> Chrome -> Brave -> Edge.
// Mit GEMINI_BROWSER_PATH laesst sich ein fixer Pfad erzwingen.
// ---------------------------------------------------------------------------
function resolveBrowser() {
  const home = os.homedir();
  const PF = process.env["ProgramFiles"] || "C:\\Program Files";
  const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const LAD = process.env["LOCALAPPDATA"] || path.join(home, "AppData", "Local");

  const candidates = [
    process.env.GEMINI_BROWSER_PATH,
    path.join(PF, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(PF86, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(LAD, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(LAD, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    path.join(PF, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    path.join(PF, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(PF86, "Microsoft\\Edge\\Application\\msedge.exe"),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    "Kein Chromium-Browser (Chrome/Brave/Edge) gefunden. Setze GEMINI_BROWSER_PATH auf deine chrome.exe/brave.exe."
  );
}

const BROWSER_PATH = (() => {
  try {
    return resolveBrowser();
  } catch (e) {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// Konfiguration -- bei UI-Aenderungen von Google hier anpassen.
// ---------------------------------------------------------------------------
const GEMINI_URL = "https://gemini.google.com/app";
const USER_DATA_DIR =
  process.env.GEMINI_PROFILE_DIR || path.join(__dirname, ".gemini-profile");
const HEADLESS = process.env.GEMINI_HEADLESS === "1";

const SEL = {
  // Eingabefeld (Quill-Editor, contenteditable). Locale-unabhaengig ueber Klasse.
  editor: 'div.ql-editor[contenteditable="true"]',
  // Antwort-Container (Web-Component) + Markdown-Body darin.
  response: "model-response",
  responseText: ".markdown",
  // "+"-Knopf, der das Upload-/Tools-Menue oeffnet. Per Rolle/Name ansprechen
  // (CSS-Attribut-Selektor scheitert am "&" -> CSS-Nesting-Token).
  uploadTriggerName: "Uploads & Tools",
  // Menuepunkt "Dateien hochladen" (oeffnet den Datei-Dialog).
  uploadMenuItemText: "Dateien hochladen",
  // Modell-Auswahl (Dropdown) -- Trigger per Teil-Name.
  modelTriggerName: /Modusauswahl öffnen/i,
  // Modus-Umschalter im "+"-Menue (role=menuitemcheckbox).
  imageModeName: /Bild erstellen/i,
  videoModeName: /Video erstellen/i,
};

// Benutzerfreundliche Modell-Schluessel -> Menuepunkt-Name im Dropdown.
const MODEL_MAP = {
  "flash-lite": /3\.1 Flash-Lite/i,
  "3.1-flash-lite": /3\.1 Flash-Lite/i,
  flash: /3\.5 Flash/i,
  "3.5-flash": /3\.5 Flash/i,
  pro: /3\.1 Pro/i,
  "3.1-pro": /3\.1 Pro/i,
};

// Ausgabeordner fuer generierte Bilder/Videos.
const OUTPUT_DIR = process.env.GEMINI_OUTPUT_DIR || path.join(__dirname, "output");

// ---------------------------------------------------------------------------
// Browser-Singleton (bleibt zwischen Tool-Aufrufen offen).
// ---------------------------------------------------------------------------
let ctx = null;
let page = null;

async function launch({ headless = HEADLESS } = {}) {
  if (!BROWSER_PATH) {
    throw new Error(
      "Kein Browser gefunden. Setze die Umgebungsvariable GEMINI_BROWSER_PATH auf deine chrome.exe / brave.exe / msedge.exe."
    );
  }
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    executablePath: BROWSER_PATH,
    viewport: { width: 1280, height: 900 },
    // CSP umgehen, damit fetch() auf blob:-URLs (generierte Videos) klappt.
    bypassCSP: true,
    // Anti-Automation: damit Google den Login im gesteuerten Browser zulaesst.
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const pg = context.pages()[0] || (await context.newPage());
  return { context, pg };
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  const launched = await launch();
  ctx = launched.context;
  page = launched.pg;
  if (!/gemini\.google\.com/.test(page.url())) {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  }
  return page;
}

// Eingeloggt = Editor vorhanden UND kein "Anmelden"/"Sign in"-Button.
// (Das Eingabefeld erscheint auf der Gemini-Landingpage auch ohne Login.)
const LOGIN_PREDICATE = () => {
  const hasEditor = !!document.querySelector('div.ql-editor[contenteditable="true"]');
  const hasSignIn = [...document.querySelectorAll("a,button")].some((e) =>
    /^\s*(anmelden|sign in)\s*$/i.test((e.textContent || "").trim())
  );
  return hasEditor && !hasSignIn;
};

async function isLoggedIn(p) {
  try {
    await p.waitForSelector(SEL.editor, { timeout: 8000 });
    await p.waitForTimeout(500);
    return await p.evaluate(LOGIN_PREDICATE);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Datei-Upload (Multimodalitaet): "+" -> "Dateien hochladen" -> filechooser.
// ---------------------------------------------------------------------------
async function uploadFiles(p, files) {
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`Datei nicht gefunden: ${f}`);
  }
  if (process.env.GEMINI_DEBUG === "1") {
    await p
      .screenshot({ path: path.join(__dirname, "debug-upload.png") })
      .catch(() => {});
    const labels = await p
      .evaluate(() =>
        [...document.querySelectorAll("button")]
          .map((b) => b.getAttribute("aria-label"))
          .filter(Boolean)
      )
      .catch(() => []);
    process.stderr.write("[debug] buttons: " + JSON.stringify(labels) + "\n");
  }
  const trigger = p.getByRole("button", { name: SEL.uploadTriggerName }).first();
  await trigger.waitFor({ state: "visible", timeout: 30000 });
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  // Echter Klick (User-Geste, noetig fuer den Datei-Dialog); bei
  // Aktionsproblemen JS-Klick als Fallback, um das Menue zu oeffnen.
  try {
    await trigger.click({ timeout: 8000 });
  } catch {
    await trigger.evaluate((el) => el.click());
  }

  const menuItem = p
    .getByRole("menuitem", { name: SEL.uploadMenuItemText })
    .first();
  await menuItem.waitFor({ state: "visible", timeout: 8000 });

  // Der Menue-Klick muss eine echte User-Geste sein, damit der
  // Datei-Dialog (filechooser) ausgeloest wird.
  const [chooser] = await Promise.all([
    p.waitForEvent("filechooser", { timeout: 10000 }),
    menuItem.click(),
  ]);
  await chooser.setFiles(files);

  // Warten bis die Vorschau/Chips erscheinen (Upload verarbeitet).
  await p.waitForTimeout(1500);
  // Best-effort: warten bis evtl. "wird hochgeladen"-Spinner verschwindet.
  await p
    .waitForFunction(() => !document.querySelector('[role="progressbar"]'), {
      timeout: 60000,
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Modell auswaehlen (Dropdown im Eingabebereich).
// ---------------------------------------------------------------------------
async function selectModel(p, model) {
  if (!model) return;
  const key = String(model).toLowerCase().trim();
  const target = MODEL_MAP[key];
  if (!target) {
    throw new Error(
      `Unbekanntes Modell "${model}". Erlaubt: ${Object.keys(MODEL_MAP).join(", ")}`
    );
  }
  const trigger = p.getByRole("button", { name: SEL.modelTriggerName }).first();
  await trigger.waitFor({ state: "visible", timeout: 15000 });
  await trigger.click();
  const item = p.getByRole("menuitem", { name: target }).first();
  await item.waitFor({ state: "visible", timeout: 8000 });
  await item.click();
  await p.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// "+"-Menue oeffnen und einen Modus-Schalter (Bild/Video) aktivieren.
// ---------------------------------------------------------------------------
async function enableMode(p, modeName) {
  const trigger = p.getByRole("button", { name: SEL.uploadTriggerName }).first();
  await trigger.waitFor({ state: "visible", timeout: 30000 });
  try {
    await trigger.click({ timeout: 8000 });
  } catch {
    await trigger.evaluate((el) => el.click());
  }
  const item = p.getByRole("menuitemcheckbox", { name: modeName }).first();
  await item.waitFor({ state: "visible", timeout: 8000 });
  await item.click();
  await p.waitForTimeout(800);
}

// ---------------------------------------------------------------------------
// Prompt in den Editor schreiben und absenden.
// ---------------------------------------------------------------------------
async function sendPrompt(p, prompt) {
  const editor = p.locator(SEL.editor).first();
  await editor.click();
  await p.keyboard.insertText(prompt);
  await p.keyboard.press("Enter");
}

// ---------------------------------------------------------------------------
// Auf stabilen Antworttext warten (Streaming fertig).
// ---------------------------------------------------------------------------
async function waitForStableText(p, before, deadline) {
  while (Date.now() < deadline) {
    if ((await p.locator(SEL.response).count()) > before) break;
    await p.waitForTimeout(300);
  }
  let lastText = "";
  let stableCount = 0;
  const STABLE_NEEDED = 5;
  while (Date.now() < deadline) {
    const txt = await p
      .locator(SEL.response)
      .last()
      .locator(SEL.responseText)
      .first()
      .innerText()
      .catch(() => "");
    if (txt && txt === lastText) {
      stableCount++;
      if (stableCount >= STABLE_NEEDED) break;
    } else {
      stableCount = 0;
      lastText = txt;
    }
    await p.waitForTimeout(500);
  }
  return lastText.trim();
}

// ---------------------------------------------------------------------------
// Generierte Medien (Bild/Video) aus der letzten Antwort holen und speichern.
// In-Page-fetch -> base64 (laeuft mit den Login-Cookies, funktioniert fuer
// blob:/https:/data:-Quellen).
// ---------------------------------------------------------------------------
async function extractMedia(p, kind, deadline) {
  const minDim = 200; // UI-Icons/Avatare ausfiltern
  // 1) Warten bis ein echtes Medium in der letzten Antwort geladen ist.
  while (Date.now() < deadline) {
    const ready = await p
      .evaluate(
        ({ kind, minDim }) => {
          const resp = document.querySelectorAll("model-response");
          const last = resp[resp.length - 1];
          if (!last) return false;
          if (kind === "video") {
            const v = last.querySelector("video");
            return !!(v && (v.src || v.currentSrc));
          }
          const imgs = [...last.querySelectorAll("img")].filter(
            (im) => im.naturalWidth >= minDim && im.naturalHeight >= minDim
          );
          return imgs.length > 0;
        },
        { kind, minDim }
      )
      .catch(() => false);
    if (ready) break;
    await p.waitForTimeout(1500);
  }

  if (process.env.GEMINI_DEBUG === "1") {
    await p
      .screenshot({ path: path.join(__dirname, `debug-${kind}.png`), fullPage: true })
      .catch(() => {});
    const dbg = await p
      .evaluate(() => {
        const resp = document.querySelectorAll("model-response");
        const last = resp[resp.length - 1];
        if (!last) return { responses: resp.length, note: "keine model-response" };
        const imgs = [...last.querySelectorAll("img")].map((im) => ({
          w: im.naturalWidth,
          h: im.naturalHeight,
          src: (im.src || "").slice(0, 60),
        }));
        const vids = [...last.querySelectorAll("video")].map((v) => ({
          src: (v.currentSrc || v.src || "").slice(0, 60),
        }));
        return {
          responses: resp.length,
          imgs,
          vids,
          text: (last.innerText || "").replace(/\s+/g, " ").slice(0, 200),
          html: last.innerHTML.slice(0, 600),
        };
      })
      .catch((e) => ({ error: String(e) }));
    process.stderr.write("[debug media] " + JSON.stringify(dbg, null, 2) + "\n");
  }

  // 2) Medien-Bytes holen.
  let media = [];
  if (kind === "video") {
    // Video-<src> einsammeln; meist eine signierte https-URL (cross-origin).
    const urls = await p.evaluate(() => {
      const resp = document.querySelectorAll("model-response");
      const last = resp[resp.length - 1];
      if (!last) return [];
      return [...last.querySelectorAll("video")]
        .map((v) => v.currentSrc || v.src)
        .filter(Boolean);
    });
    const apiCtx = p.context().request; // Node-seitiger Fetch -> kein CORS
    for (const url of urls) {
      try {
        if (url.startsWith("blob:")) {
          // blob: nur in-page erreichbar (bypassCSP aktiv).
          const b64 = await p.evaluate(async (u) => {
            const r = await fetch(u);
            const b = await r.blob();
            const d = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(fr.error || new Error("FileReader"));
              fr.readAsDataURL(b);
            });
            return String(d).split(",")[1];
          }, url);
          media.push({ b64, type: "video/mp4" });
        } else {
          const r = await apiCtx.get(url);
          media.push({
            buffer: await r.body(),
            type: r.headers()["content-type"] || "video/mp4",
          });
        }
      } catch (e) {
        media.push({ error: String(e), src: url.slice(0, 100) });
      }
    }
  } else {
    // Bild: <img> auf Canvas zeichnen und exportieren -> umgeht fetch-CSP.
    media = await p.evaluate(
      ({ minDim }) => {
        const resp = document.querySelectorAll("model-response");
        const last = resp[resp.length - 1];
        const out = [];
        if (!last) return out;
        const imgs = [...last.querySelectorAll("img")].filter(
          (im) => im.naturalWidth >= minDim && im.naturalHeight >= minDim
        );
        for (const im of imgs) {
          try {
            const c = document.createElement("canvas");
            c.width = im.naturalWidth;
            c.height = im.naturalHeight;
            c.getContext("2d").drawImage(im, 0, 0);
            out.push({ b64: c.toDataURL("image/png").split(",")[1], type: "image/png" });
          } catch (e) {
            out.push({ error: String(e), src: (im.src || "").slice(0, 100) });
          }
        }
        return out;
      },
      { minDim }
    );
  }

  if (process.env.GEMINI_DEBUG === "1") {
    process.stderr.write(
      "[debug fetched] " +
        JSON.stringify(
          media.map((m) =>
            m.b64
              ? { ok: "b64", type: m.type, len: m.b64.length }
              : m.buffer
                ? { ok: "buffer", type: m.type, bytes: m.buffer.length }
                : m
          )
        ) +
        "\n"
    );
  }

  // 3) Auf die Platte schreiben (Buffer oder base64).
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const saved = [];
  const stamp = Date.now();
  let i = 0;
  for (const m of media) {
    if (!m || (!m.b64 && !m.buffer)) continue;
    const ext =
      kind === "video"
        ? (m.type || "").includes("webm")
          ? "webm"
          : "mp4"
        : (m.type || "").includes("png")
          ? "png"
          : (m.type || "").includes("webp")
            ? "webp"
            : "jpg";
    const file = path.join(OUTPUT_DIR, `gemini-${kind}-${stamp}-${i++}.${ext}`);
    fs.writeFileSync(
      file,
      m.buffer ? m.buffer : Buffer.from(m.b64, "base64")
    );
    saved.push(file);
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Kernfunktion: Prompt senden, auf Antwort warten, Text zurueckgeben.
// ---------------------------------------------------------------------------
async function askGemini({
  prompt,
  files = [],
  new_chat = false,
  model = null,
  timeout_seconds = 180,
}) {
  if (!prompt || !prompt.trim()) throw new Error("prompt ist leer.");
  const p = await ensurePage();

  if (new_chat) {
    await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  }
  if (!(await isLoggedIn(p))) {
    throw new Error(
      "Nicht bei Gemini eingeloggt. Bitte einmalig `npm run login` (bzw. `node server.js login`) ausfuehren und einloggen."
    );
  }

  if (model) await selectModel(p, model);

  const editor = p.locator(SEL.editor).first();
  await editor.click();

  if (files.length) await uploadFiles(p, files);

  const before = await p.locator(SEL.response).count();
  await sendPrompt(p, prompt);

  const deadline = Date.now() + timeout_seconds * 1000;
  const lastText = await waitForStableText(p, before, deadline);

  if (!lastText) {
    throw new Error(
      "Keine Antwort von Gemini erkannt (Timeout oder UI-Aenderung). Selektoren in SEL pruefen."
    );
  }
  return lastText;
}

// ---------------------------------------------------------------------------
// Bild generieren (Gemini "Bild erstellen" / Nano Banana).
// ---------------------------------------------------------------------------
async function generateImage({ prompt, new_chat = true, timeout_seconds = 180 }) {
  if (!prompt || !prompt.trim()) throw new Error("prompt ist leer.");
  const p = await ensurePage();
  if (new_chat) await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p)))
    throw new Error("Nicht bei Gemini eingeloggt. Bitte `npm run login` ausfuehren.");

  await enableMode(p, SEL.imageModeName);
  const before = await p.locator(SEL.response).count();
  await sendPrompt(p, prompt);

  const deadline = Date.now() + timeout_seconds * 1000;
  // Warten bis eine neue Antwort erscheint.
  while (Date.now() < deadline) {
    if ((await p.locator(SEL.response).count()) > before) break;
    await p.waitForTimeout(500);
  }
  const files = await extractMedia(p, "image", deadline);
  if (!files.length)
    throw new Error(
      "Kein Bild gefunden (Timeout oder UI-Aenderung). Mit GEMINI_DEBUG=1 pruefen."
    );
  return files;
}

// ---------------------------------------------------------------------------
// Video generieren (Gemini "Video erstellen" / Veo). Dauert i.d.R. 1-3 Min.
// ---------------------------------------------------------------------------
async function generateVideo({ prompt, new_chat = true, timeout_seconds = 420 }) {
  if (!prompt || !prompt.trim()) throw new Error("prompt ist leer.");
  const p = await ensurePage();
  if (new_chat) await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p)))
    throw new Error("Nicht bei Gemini eingeloggt. Bitte `npm run login` ausfuehren.");

  await enableMode(p, SEL.videoModeName);

  // Einmaliges Onboarding-Popup ("Videos erstellen - Mit Gemini Omni")
  // beim ersten Mal wegklicken.
  const tryBtn = p.getByRole("button", { name: /Jetzt ausprobieren/i }).first();
  if (await tryBtn.isVisible().catch(() => false)) {
    await tryBtn.click().catch(() => {});
    await p.waitForTimeout(1000);
  }

  const before = await p.locator(SEL.response).count();
  await sendPrompt(p, prompt);

  const deadline = Date.now() + timeout_seconds * 1000;
  while (Date.now() < deadline) {
    if ((await p.locator(SEL.response).count()) > before) break;
    await p.waitForTimeout(1000);
  }
  const files = await extractMedia(p, "video", deadline);
  if (!files.length)
    throw new Error(
      "Kein Video gefunden (Timeout oder UI-Aenderung). Mit GEMINI_DEBUG=1 pruefen."
    );
  return files;
}

// ---------------------------------------------------------------------------
// Diagnose: ist das Profil wirklich eingeloggt?
// ---------------------------------------------------------------------------
async function runCheck() {
  const { context, pg } = await launch({ headless: true });
  await pg.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(3000);
  const info = await pg.evaluate(() => {
    const txt = (document.body.innerText || "").slice(0, 400);
    const signIn = [...document.querySelectorAll("a,button")].some((e) =>
      /anmelden|sign in|in google account anmelden/i.test(e.textContent || "")
    );
    const editor = !!document.querySelector('div.ql-editor[contenteditable="true"]');
    const account = document.querySelector('[aria-label*="Google-Konto"], [aria-label*="Google Account"]');
    return {
      url: location.href,
      hasEditor: editor,
      hasSignInButton: signIn,
      accountLabel: account ? account.getAttribute("aria-label") : null,
      bodyStart: txt.replace(/\s+/g, " ").trim(),
    };
  });
  process.stdout.write(JSON.stringify(info, null, 2) + "\n");
  await context.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Diagnose: alle Buttons im Eingabebereich dumpen (Selektor-Suche).
// ---------------------------------------------------------------------------
async function runDump() {
  const { context, pg } = await launch({ headless: true });
  await pg.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  await pg.waitForSelector(SEL.editor, { timeout: 15000 });
  await pg.waitForTimeout(1500);
  const data = await pg.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].map((b) => ({
      aria: b.getAttribute("aria-label"),
      icon: b.querySelector("mat-icon")?.textContent?.trim(),
      cls: (b.className || "").slice(0, 40),
    }));
    // nur interessante (mit aria oder icon)
    return btns.filter((b) => b.aria || b.icon).slice(0, 40);
  });
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  await context.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Login-Modus (einmalig).
// ---------------------------------------------------------------------------
async function runLogin() {
  process.stderr.write("\n>> Browser: " + BROWSER_PATH + "\n");
  const { context, pg } = await launch({ headless: false });
  await pg.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  process.stderr.write(
    ">> Bitte im geoeffneten Fenster bei Google/Gemini einloggen.\n" +
      ">> Warte auf das Eingabefeld (max. 5 Min)...\n"
  );
  try {
    await pg.waitForFunction(LOGIN_PREDICATE, null, {
      timeout: 300000,
      polling: 1000,
    });
    process.stderr.write(
      ">> Login erkannt. Profil gespeichert unter:\n   " +
        USER_DATA_DIR +
        "\n>> Fenster wird in 3s geschlossen.\n\n"
    );
    await pg.waitForTimeout(3000);
  } catch {
    process.stderr.write(">> Kein Login innerhalb 5 Min erkannt. Abbruch.\n");
  }
  await context.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI-Schnelltest.
// ---------------------------------------------------------------------------
async function runAsk(args) {
  // Tokens "--file=PFAD" = Upload, "--model=KEY" = Modell, Rest = Prompt.
  const files = [];
  const promptParts = [];
  let model = null;
  for (const a of args) {
    if (a.startsWith("--file=")) files.push(a.slice("--file=".length));
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else promptParts.push(a);
  }
  const prompt =
    promptParts.join(" ") ||
    "Sag in genau einem Satz Hallo und nenne das heutige Datum.";
  const answer = await askGemini({ prompt, files, model });
  process.stdout.write("\n--- Gemini ---\n" + answer + "\n--------------\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

async function runImage(args) {
  const prompt = args.join(" ");
  if (!prompt) throw new Error('Nutze: node server.js image "Bildbeschreibung"');
  const files = await generateImage({ prompt });
  process.stdout.write("\n--- Bild(er) ---\n" + files.join("\n") + "\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

async function runVideo(args) {
  const prompt = args.join(" ");
  if (!prompt) throw new Error('Nutze: node server.js video "Videobeschreibung"');
  const files = await generateVideo({ prompt });
  process.stdout.write("\n--- Video(s) ---\n" + files.join("\n") + "\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

// Test-Helfer: Video-Modus betreten + Onboarding abfangen, OHNE zu generieren.
async function runVmode() {
  const p = await ensurePage();
  await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p))) throw new Error("Nicht eingeloggt.");
  await enableMode(p, SEL.videoModeName);
  const tryBtn = p.getByRole("button", { name: /Jetzt ausprobieren/i }).first();
  const hadOnboard = await tryBtn.isVisible().catch(() => false);
  if (hadOnboard) {
    await tryBtn.click().catch(() => {});
    await p.waitForTimeout(1000);
  }
  await p.waitForTimeout(1000);
  const state = await p.evaluate(() => {
    const ed = document.querySelector('div.ql-editor[contenteditable="true"]');
    const chip = [...document.querySelectorAll("*")].some(
      (e) => (e.textContent || "").trim() === "Videos" && e.children.length === 0
    );
    return { placeholder: ed?.getAttribute("data-placeholder"), videosChip: chip };
  });
  process.stdout.write(
    "onboarding_popup:" + hadOnboard + "  state:" + JSON.stringify(state) + "\n"
  );
  if (ctx) await ctx.close();
  process.exit(0);
}

// Test-Helfer: Medien aus einem bestehenden Chat extrahieren (ohne Generierung).
// Nutze: node server.js extract video <chatUrl>
async function runExtract(args) {
  const kind = args[0] === "image" ? "image" : "video";
  const url = args[1];
  if (!url) throw new Error("Nutze: node server.js extract <image|video> <chatUrl>");
  const p = await ensurePage();
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4000);
  const files = await extractMedia(p, kind, Date.now() + 120000);
  process.stdout.write("\n--- extrahiert ---\n" + files.join("\n") + "\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// MCP-Server (stdio).
// ---------------------------------------------------------------------------
async function buildServer() {
  const { Server } = await import(
    "@modelcontextprotocol/sdk/server/index.js"
  );
  const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");

  const server = new Server(
    { name: "gemini-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ask_gemini",
        description:
          "Stellt eine Frage an Google Gemini ueber die eingeloggte Weboberflaeche (kein API-Key noetig). " +
          "Unterstuetzt Multimodalitaet: optional Bilder/PDFs/Videos/Audio per Dateipfad mitschicken; " +
          "Gemini analysiert sie und antwortet als Text. Modellwahl moeglich. Gibt Geminis Antworttext zurueck. " +
          "Gut fuer Video-/Audio-Verstaendnis, sehr lange Dokumente oder eine Zweitmeinung eines anderen Modells.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Die Frage / der Auftrag an Gemini." },
            files: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional. Absolute Pfade zu Dateien (Bild/PDF/Video/Audio), die mitgeschickt werden.",
            },
            model: {
              type: "string",
              enum: ["flash-lite", "flash", "pro"],
              description:
                "Optional. Modell: 'flash-lite' (3.1 Flash-Lite, schnellste), 'flash' (3.5 Flash, vielseitig), 'pro' (3.1 Pro, komplexe Aufgaben). Default: aktuell gewaehltes.",
            },
            new_chat: {
              type: "boolean",
              description:
                "Optional. true = neuen Chat starten (kein Verlaufskontext). Default false.",
            },
            timeout_seconds: {
              type: "number",
              description: "Optional. Max. Wartezeit in Sekunden (Default 180).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "generate_image",
        description:
          "Erzeugt ein Bild mit Gemini (Bildmodell 'Nano Banana') ueber die eingeloggte Web-UI. " +
          "Speichert das/die Bild(er) auf die Platte und gibt die Dateipfade zurueck (als PNG/JPG lesbar). Kein API-Key.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Bildbeschreibung." },
            timeout_seconds: {
              type: "number",
              description: "Optional. Max. Wartezeit in Sekunden (Default 180).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "generate_video",
        description:
          "Erzeugt ein Video mit Gemini (Videomodell 'Veo') ueber die eingeloggte Web-UI. " +
          "Dauert i.d.R. 1-3 Minuten und verbraucht Veo-Kontingent des Abos. " +
          "Speichert das Video auf die Platte und gibt den Dateipfad zurueck (MP4). Kein API-Key.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Videobeschreibung." },
            timeout_seconds: {
              type: "number",
              description: "Optional. Max. Wartezeit in Sekunden (Default 420).",
            },
          },
          required: ["prompt"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const a = req.params.arguments || {};
    try {
      if (name === "ask_gemini") {
        const answer = await askGemini({
          prompt: a.prompt,
          files: Array.isArray(a.files) ? a.files : [],
          model: a.model || null,
          new_chat: !!a.new_chat,
          timeout_seconds:
            typeof a.timeout_seconds === "number" ? a.timeout_seconds : 180,
        });
        return { content: [{ type: "text", text: answer }] };
      }
      if (name === "generate_image") {
        const files = await generateImage({
          prompt: a.prompt,
          timeout_seconds:
            typeof a.timeout_seconds === "number" ? a.timeout_seconds : 180,
        });
        return {
          content: [
            {
              type: "text",
              text:
                "Bild(er) gespeichert:\n" +
                files.join("\n") +
                "\n(Mit dem Read-Tool oeffnen, um sie anzusehen.)",
            },
          ],
        };
      }
      if (name === "generate_video") {
        const files = await generateVideo({
          prompt: a.prompt,
          timeout_seconds:
            typeof a.timeout_seconds === "number" ? a.timeout_seconds : 420,
        });
        return {
          content: [{ type: "text", text: "Video gespeichert:\n" + files.join("\n") }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `Unbekanntes Tool: ${name}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: "Fehler: " + (err?.message || String(err)) }],
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// stdio-Modus (fuer Claude Code).
// ---------------------------------------------------------------------------
async function runMcp() {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("gemini-bridge MCP-Server laeuft (stdio).\n");
}

// ---------------------------------------------------------------------------
// HTTP-Modus (Streamable HTTP) -- fuer Claude Desktop als Remote-Connector.
// URL zum Eintragen:  http://localhost:<PORT>/mcp   (Default-Port 7801)
// ---------------------------------------------------------------------------
async function runHttp() {
  const http = await import("node:http");
  const https = await import("node:https");
  const { randomUUID } = await import("node:crypto");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { isInitializeRequest } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const PORT = Number(process.env.GEMINI_PORT || 7801);
  const transports = {}; // sessionId -> transport

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });

  const handler = async (req, res) => {
    // CORS: der Claude-App-Renderer greift cross-origin zu und muss u. a. den
    // mcp-session-id-Header lesen koennen (sonst bleibt die Verbindung haengen).
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Authorization"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, Mcp-Protocol-Version"
    );

    if (process.env.GEMINI_DEBUG === "1") {
      process.stderr.write(
        "[http] " +
          req.method +
          " " +
          req.url +
          " origin=" +
          (req.headers.origin || "-") +
          " host=" +
          (req.headers.host || "-") +
          " sid=" +
          (req.headers["mcp-session-id"] || "-") +
          " accept=" +
          (req.headers["accept"] || "-") +
          "\n"
      );
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }
    try {
      const sessionId = req.headers["mcp-session-id"];
      if (req.method === "POST") {
        const body = await readBody(req);
        let transport;
        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport;
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) delete transports[transport.sessionId];
          };
          const server = await buildServer();
          await server.connect(transport);
        } else {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Keine gueltige Session." },
                id: null,
              })
            );
          return;
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400).end("Ungueltige oder fehlende Session-ID.");
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else {
        res.writeHead(405).end("Method not allowed");
      }
    } catch (err) {
      process.stderr.write("HTTP-Fehler: " + (err?.message || err) + "\n");
      if (!res.headersSent) res.writeHead(500).end("Serverfehler");
    }
  };

  // https as soon as a local certificate exists (e.g. via mkcert) -- otherwise http.
  const certPath =
    process.env.GEMINI_TLS_CERT || path.join(__dirname, "certs", "cert.pem");
  const keyPath =
    process.env.GEMINI_TLS_KEY || path.join(__dirname, "certs", "key.pem");
  const useTls = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const httpServer = useTls
    ? https.createServer(
        { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
        handler
      )
    : http.createServer(handler);

  httpServer.listen(PORT, "127.0.0.1", () => {
    const scheme = useTls ? "https" : "http";
    process.stderr.write(
      "gemini-bridge " +
        scheme.toUpperCase() +
        "-MCP laeuft auf " +
        scheme +
        "://localhost:" +
        PORT +
        "/mcp\n"
    );
  });
}

// ---------------------------------------------------------------------------
// Einstiegspunkt.
// ---------------------------------------------------------------------------
const mode = process.argv[2];
if (mode === "login") {
  runLogin();
} else if (mode === "check") {
  runCheck();
} else if (mode === "dump") {
  runDump();
} else if (mode === "ask") {
  runAsk(process.argv.slice(3));
} else if (mode === "image") {
  runImage(process.argv.slice(3));
} else if (mode === "video") {
  runVideo(process.argv.slice(3));
} else if (mode === "extract") {
  runExtract(process.argv.slice(3));
} else if (mode === "vmode") {
  runVmode();
} else if (mode === "http") {
  runHttp();
} else {
  runMcp();
}

// sauberes Beenden
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      if (ctx) await ctx.close();
    } catch {}
    process.exit(0);
  });
}
