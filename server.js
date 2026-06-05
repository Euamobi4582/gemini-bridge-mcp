#!/usr/bin/env node
/**
 * gemini-bridge-mcp
 * -----------------
 * An MCP server that talks to your LOGGED-IN Gemini web UI
 * (gemini.google.com) via browser automation. No API key, no API cost --
 * it all runs through your normal Gemini subscription, exactly as if you
 * were typing in the browser yourself.
 *
 * Uses your installed Chromium browser (playwright-core; Chrome/Brave/Edge,
 * auto-detected) and its own persistent login profile under ./.gemini-profile,
 * so you only have to log in ONCE.
 *
 * Modes:
 *   node server.js login        -> open a window, log in once
 *   node server.js ask "..."    -> quick CLI test
 *   node server.js              -> run as an MCP server over stdio
 *
 * Built with the help of Claude Code (Anthropic's Claude Opus 4.8, extended thinking).
 */

import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Locate a Chromium binary. Order: explicit env -> Chrome -> Brave -> Edge.
// Set GEMINI_BROWSER_PATH to force a specific path.
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
    // Common Linux / macOS locations:
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/brave-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    "No Chromium browser (Chrome/Brave/Edge) found. Set GEMINI_BROWSER_PATH to your chrome.exe / brave.exe / chrome binary."
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
// Configuration.
// ---------------------------------------------------------------------------
const GEMINI_URL = "https://gemini.google.com/app";
const USER_DATA_DIR =
  process.env.GEMINI_PROFILE_DIR || path.join(__dirname, ".gemini-profile");
const HEADLESS = process.env.GEMINI_HEADLESS === "1";

// Selectors / UI strings.
//
// NOTE: some of the values below match the *German* Gemini web UI
// ("Dateien hochladen", "Bild erstellen", "Video erstellen",
// "Modusauswahl öffnen", "Jetzt ausprobieren", ...). If your Gemini UI is in
// another language, change them to the matching labels (English would be
// "Upload files", "Create image", "Create video", ...). Run
// `node server.js dump` to print the current button labels.
const SEL = {
  // Input field (Quill editor, contenteditable). Locale-independent via class.
  editor: 'div.ql-editor[contenteditable="true"]',
  // Response container (web component) + its markdown body.
  response: "model-response",
  responseText: ".markdown",
  // "+" button that opens the upload/tools menu. Matched by role/name
  // (a CSS attribute selector fails on the "&" -> CSS nesting token).
  uploadTriggerName: "Uploads & Tools",
  // Menu item "Upload files" (opens the file dialog). [German UI label]
  uploadMenuItemText: "Dateien hochladen",
  // Model picker (dropdown) -- trigger matched by partial name. [German UI label]
  modelTriggerName: /Modusauswahl öffnen/i,
  // Mode toggles in the "+" menu (role=menuitemcheckbox). [German UI labels]
  imageModeName: /Bild erstellen/i,
  videoModeName: /Video erstellen/i,
};

// Friendly model keys -> menu-item name in the dropdown.
const MODEL_MAP = {
  "flash-lite": /3\.1 Flash-Lite/i,
  "3.1-flash-lite": /3\.1 Flash-Lite/i,
  flash: /3\.5 Flash/i,
  "3.5-flash": /3\.5 Flash/i,
  pro: /3\.1 Pro/i,
  "3.1-pro": /3\.1 Pro/i,
};

// Output folder for generated images/videos.
const OUTPUT_DIR = process.env.GEMINI_OUTPUT_DIR || path.join(__dirname, "output");

// ---------------------------------------------------------------------------
// Browser singleton (stays open between tool calls).
// ---------------------------------------------------------------------------
let ctx = null;
let page = null;

async function launch({ headless = HEADLESS } = {}) {
  if (!BROWSER_PATH) {
    throw new Error(
      "No browser found. Set the GEMINI_BROWSER_PATH environment variable to your chrome.exe / brave.exe / msedge.exe."
    );
  }
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    executablePath: BROWSER_PATH,
    viewport: { width: 1280, height: 900 },
    // Bypass CSP so fetch() on blob: URLs (generated videos) works.
    bypassCSP: true,
    // Anti-automation: lets Google allow the login in the controlled browser.
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

// Logged in = editor present AND no "Sign in"/"Anmelden" button.
// (The input field also shows on the Gemini landing page when logged out.)
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
// File upload (multimodality): "+" -> "Upload files" -> filechooser.
// ---------------------------------------------------------------------------
async function uploadFiles(p, files) {
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
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
  // Real click (user gesture, required for the file dialog); fall back to a
  // JS click to open the menu if the action check fails.
  try {
    await trigger.click({ timeout: 8000 });
  } catch {
    await trigger.evaluate((el) => el.click());
  }

  const menuItem = p
    .getByRole("menuitem", { name: SEL.uploadMenuItemText })
    .first();
  await menuItem.waitFor({ state: "visible", timeout: 8000 });

  // The menu click must be a real user gesture so the file dialog
  // (filechooser) is triggered.
  const [chooser] = await Promise.all([
    p.waitForEvent("filechooser", { timeout: 10000 }),
    menuItem.click(),
  ]);
  await chooser.setFiles(files);

  // Wait for the preview/chips to appear (upload processed).
  await p.waitForTimeout(1500);
  // Best effort: wait until any "uploading" spinner disappears.
  await p
    .waitForFunction(() => !document.querySelector('[role="progressbar"]'), {
      timeout: 60000,
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Select a model (dropdown in the input area).
// ---------------------------------------------------------------------------
async function selectModel(p, model) {
  if (!model) return;
  const key = String(model).toLowerCase().trim();
  const target = MODEL_MAP[key];
  if (!target) {
    throw new Error(
      `Unknown model "${model}". Allowed: ${Object.keys(MODEL_MAP).join(", ")}`
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
// Open the "+" menu and toggle a mode (image/video).
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
// Type the prompt into the editor and send it.
// ---------------------------------------------------------------------------
async function sendPrompt(p, prompt) {
  const editor = p.locator(SEL.editor).first();
  await editor.click();
  await p.keyboard.insertText(prompt);
  await p.keyboard.press("Enter");
}

// ---------------------------------------------------------------------------
// Wait until the response text is stable (streaming finished).
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
// Pull generated media (image/video) from the last response and save it.
// Images: drawn to a <canvas> (works around the page's fetch CSP).
// Videos: downloaded server-side with the session cookies (signed URLs).
// ---------------------------------------------------------------------------
async function extractMedia(p, kind, deadline) {
  const minDim = 200; // filter out UI icons/avatars
  // 1) Wait until a real medium has loaded in the last response.
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
        if (!last) return { responses: resp.length, note: "no model-response" };
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

  // 2) Grab the media bytes.
  let media = [];
  if (kind === "video") {
    // Collect <video> srcs; usually a signed cross-origin https URL.
    const urls = await p.evaluate(() => {
      const resp = document.querySelectorAll("model-response");
      const last = resp[resp.length - 1];
      if (!last) return [];
      return [...last.querySelectorAll("video")]
        .map((v) => v.currentSrc || v.src)
        .filter(Boolean);
    });
    const apiCtx = p.context().request; // server-side fetch -> no CORS
    for (const url of urls) {
      try {
        if (url.startsWith("blob:")) {
          // blob: is only reachable in-page (bypassCSP is on).
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
    // Image: draw the <img> onto a canvas and export it -> bypasses the fetch CSP.
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

  // 3) Write to disk (Buffer or base64).
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
// Core: send a prompt, wait for the answer, return the text.
// ---------------------------------------------------------------------------
async function askGemini({
  prompt,
  files = [],
  new_chat = false,
  model = null,
  timeout_seconds = 180,
}) {
  if (!prompt || !prompt.trim()) throw new Error("prompt is empty.");
  const p = await ensurePage();

  if (new_chat) {
    await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  }
  if (!(await isLoggedIn(p))) {
    throw new Error(
      "Not logged in to Gemini. Run `npm run login` (or `node server.js login`) once and sign in."
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
      "No answer detected from Gemini (timeout or UI change). Check the selectors in SEL."
    );
  }
  return lastText;
}

// ---------------------------------------------------------------------------
// Generate an image (Gemini "Create image" / Nano Banana).
// ---------------------------------------------------------------------------
async function generateImage({ prompt, new_chat = true, timeout_seconds = 180 }) {
  if (!prompt || !prompt.trim()) throw new Error("prompt is empty.");
  const p = await ensurePage();
  if (new_chat) await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p)))
    throw new Error("Not logged in to Gemini. Run `npm run login`.");

  await enableMode(p, SEL.imageModeName);
  const before = await p.locator(SEL.response).count();
  await sendPrompt(p, prompt);

  const deadline = Date.now() + timeout_seconds * 1000;
  // Wait until a new response appears.
  while (Date.now() < deadline) {
    if ((await p.locator(SEL.response).count()) > before) break;
    await p.waitForTimeout(500);
  }
  const files = await extractMedia(p, "image", deadline);
  if (!files.length)
    throw new Error(
      "No image found (timeout or UI change). Check with GEMINI_DEBUG=1."
    );
  return files;
}

// ---------------------------------------------------------------------------
// Generate a video (Gemini "Create video" / Veo). Usually takes 1-3 min.
// ---------------------------------------------------------------------------
async function generateVideo({ prompt, new_chat = true, timeout_seconds = 420 }) {
  if (!prompt || !prompt.trim()) throw new Error("prompt is empty.");
  const p = await ensurePage();
  if (new_chat) await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p)))
    throw new Error("Not logged in to Gemini. Run `npm run login`.");

  await enableMode(p, SEL.videoModeName);

  // Dismiss the one-time onboarding popup ("Create videos - with Gemini Omni")
  // on first use. [German UI label]
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
      "No video found (timeout or UI change). Check with GEMINI_DEBUG=1."
    );
  return files;
}

// ---------------------------------------------------------------------------
// Diagnostic: is the profile actually logged in?
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
// Diagnostic: dump all input-area button labels (selector hunting).
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
    // only the interesting ones (with aria or icon)
    return btns.filter((b) => b.aria || b.icon).slice(0, 40);
  });
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  await context.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Login mode (one-time).
// ---------------------------------------------------------------------------
async function runLogin() {
  process.stderr.write("\n>> Browser: " + BROWSER_PATH + "\n");
  const { context, pg } = await launch({ headless: false });
  await pg.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  process.stderr.write(
    ">> Please sign in to Google/Gemini in the window that just opened.\n" +
      ">> Waiting for the input field (up to 5 min)...\n"
  );
  try {
    await pg.waitForFunction(LOGIN_PREDICATE, null, {
      timeout: 300000,
      polling: 1000,
    });
    process.stderr.write(
      ">> Login detected. Profile saved at:\n   " +
        USER_DATA_DIR +
        "\n>> Closing the window in 3s.\n\n"
    );
    await pg.waitForTimeout(3000);
  } catch {
    process.stderr.write(">> No login detected within 5 min. Aborting.\n");
  }
  await context.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Quick CLI test.
// ---------------------------------------------------------------------------
async function runAsk(args) {
  // Tokens "--file=PATH" = upload, "--model=KEY" = model, rest = prompt.
  const files = [];
  const promptParts = [];
  let model = null;
  for (const a of args) {
    if (a.startsWith("--file=")) files.push(a.slice("--file=".length));
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else promptParts.push(a);
  }
  const prompt =
    promptParts.join(" ") || "Say hello in exactly one sentence.";
  const answer = await askGemini({ prompt, files, model });
  process.stdout.write("\n--- Gemini ---\n" + answer + "\n--------------\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

async function runImage(args) {
  const prompt = args.join(" ");
  if (!prompt) throw new Error('Usage: node server.js image "image description"');
  const files = await generateImage({ prompt });
  process.stdout.write("\n--- image(s) ---\n" + files.join("\n") + "\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

async function runVideo(args) {
  const prompt = args.join(" ");
  if (!prompt) throw new Error('Usage: node server.js video "video description"');
  const files = await generateVideo({ prompt });
  process.stdout.write("\n--- video(s) ---\n" + files.join("\n") + "\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

// Test helper: enter video mode + dismiss onboarding, WITHOUT generating.
async function runVmode() {
  const p = await ensurePage();
  await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p))) throw new Error("Not logged in.");
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

// Test helper: extract media from an existing chat (without generating).
// Usage: node server.js extract <image|video> <chatUrl>
async function runExtract(args) {
  const kind = args[0] === "image" ? "image" : "video";
  const url = args[1];
  if (!url) throw new Error("Usage: node server.js extract <image|video> <chatUrl>");
  const p = await ensurePage();
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4000);
  const files = await extractMedia(p, kind, Date.now() + 120000);
  process.stdout.write("\n--- extracted ---\n" + files.join("\n") + "\n");
  if (ctx) await ctx.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// MCP server definition (shared by stdio and HTTP modes).
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
          "Ask Google Gemini a question through the logged-in web UI (no API key needed). " +
          "Supports multimodality: optionally attach images/PDFs/videos/audio by file path; " +
          "Gemini analyzes them and answers as text. Model selection supported. Returns Gemini's answer text. " +
          "Great for video/audio understanding, very long documents, or a second opinion from another model.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The question / instruction for Gemini." },
            files: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional. Absolute paths to files (image/PDF/video/audio) to attach.",
            },
            model: {
              type: "string",
              enum: ["flash-lite", "flash", "pro"],
              description:
                "Optional. Model: 'flash-lite' (3.1 Flash-Lite, fastest), 'flash' (3.5 Flash, versatile), 'pro' (3.1 Pro, complex tasks). Default: whatever is currently selected.",
            },
            new_chat: {
              type: "boolean",
              description:
                "Optional. true = start a new chat (no prior context). Default false (continue the current chat).",
            },
            timeout_seconds: {
              type: "number",
              description: "Optional. Max wait time in seconds (default 180).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "generate_image",
        description:
          "Generate an image with Gemini's image model ('Nano Banana') through the logged-in web UI. " +
          "Saves the image(s) to disk and returns the file paths (readable as PNG/JPG). No API key.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Image description." },
            timeout_seconds: {
              type: "number",
              description: "Optional. Max wait time in seconds (default 180).",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "generate_video",
        description:
          "Generate a video with Gemini's video model ('Veo') through the logged-in web UI. " +
          "Usually takes 1-3 minutes and consumes the subscription's Veo quota. " +
          "Saves the video to disk and returns the file path (MP4). No API key.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Video description." },
            timeout_seconds: {
              type: "number",
              description: "Optional. Max wait time in seconds (default 420).",
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
                "Image(s) saved:\n" +
                files.join("\n") +
                "\n(Open them with the Read tool to view.)",
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
          content: [{ type: "text", text: "Video saved:\n" + files.join("\n") }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: " + (err?.message || String(err)) }],
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// stdio mode (for most MCP clients, e.g. Claude Code / Claude Desktop).
// ---------------------------------------------------------------------------
async function runMcp() {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("gemini-bridge MCP server running (stdio).\n");
}

// ---------------------------------------------------------------------------
// HTTP mode (Streamable HTTP) -- for MCP clients that connect to a URL.
// URL: http://localhost:<PORT>/mcp   (default port 7801)
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
    // CORS: a browser-based MCP client connects cross-origin and needs to read
    // the mcp-session-id header (otherwise the connection just hangs).
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
                error: { code: -32000, message: "No valid session." },
                id: null,
              })
            );
          return;
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400).end("Invalid or missing session id.");
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else {
        res.writeHead(405).end("Method not allowed");
      }
    } catch (err) {
      process.stderr.write("HTTP error: " + (err?.message || err) + "\n");
      if (!res.headersSent) res.writeHead(500).end("Server error");
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
        "-MCP running at " +
        scheme +
        "://localhost:" +
        PORT +
        "/mcp\n"
    );
  });
}

// ---------------------------------------------------------------------------
// Entry point.
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

// clean shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      if (ctx) await ctx.close();
    } catch {}
    process.exit(0);
  });
}
