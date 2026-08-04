// script.js
// One-shot GitHub Actions worker for Flor videoconferences.
// Loads the supplied Vimeo downloader extension for browser parity, resolves
// Vimeo streams through the signed player configuration used by the reference script,
// downloads recordings, uploads the video to Google Drive,
// extracts audio, transcribes locally with faster-whisper, uploads the transcript,
// and records progress in the existing MySQL videos table.

"use strict";

process.env.TZ = process.env.TZ || "America/Mexico_City";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");

const { google } = require("googleapis");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const mysql = require("mysql2/promise");
const ffmpegCli = require("fluent-ffmpeg");

// GitHub runners use Ubuntu's maintained FFmpeg package. The bundled
// @ffmpeg-installer binary is from 2018 and crashes on current Vimeo HLS.
ffmpegCli.setFfmpegPath(process.env.FFMPEG_PATH || "ffmpeg");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  return value == null || String(value).trim() === "" ? fallback : String(value).trim();
}

const USER_DATA_DIR = path.resolve(__dirname, ".runtime", "puppeteer_profile");
const FILES_DIR = path.resolve(__dirname, "files");

const DRIVE_FOLDER_ID = requiredEnv("GOOGLE_DRIVE_FOLDER_ID");
const GOOGLE_IMPERSONATED_USER = optionalEnv("GOOGLE_IMPERSONATED_USER");
const GOOGLE_SERVICE_ACCOUNT_JSON = requiredEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
const WORK_LEDGER_SPREADSHEET_ID = optionalEnv(
  "FLOR_WORK_LEDGER_SPREADSHEET_ID",
  "1_pQk5GbdUXBs64xsCLg8s0L6zRORZqi5NpTZV4z1IdA"
);
const WORK_LEDGER_SCHEDULE_SHEET = optionalEnv(
  "FLOR_WORK_LEDGER_SCHEDULE_SHEET",
  "Schedule"
);

const USERNAME = requiredEnv("FLOR_USERNAME");
const PASSWORD = requiredEnv("FLOR_PASSWORD");
const SITE_BASE_URL = optionalEnv("FLOR_SITE_BASE_URL", "https://buenainfancia.com.mx").replace(/\/$/, "");
const VIDEOS_URL = `${SITE_BASE_URL}/videoconferencias`;

const PYTHON_BIN = optionalEnv("PYTHON_BIN", "python3");
const TRANSCRIBE_SCRIPT = path.resolve(__dirname, "transcribe.py");
const configuredMaxVideos = Number.parseInt(optionalEnv("MAX_VIDEOS", "1"), 10);
const MAX_VIDEOS = Number.isFinite(configuredMaxVideos) && configuredMaxVideos >= 0
  ? configuredMaxVideos
  : 0;
const HEADLESS = optionalEnv("PUPPETEER_HEADLESS", "false").toLowerCase() !== "false";
const VIMEO_EXTENSION_ID = optionalEnv(
  "VIMEO_EXTENSION_ID",
  "penndbmahnpapepljikkjmakcobdahne"
);
const VIMEO_EXTENSION_DIR = path.resolve(
  optionalEnv(
    "VIMEO_EXTENSION_DIR",
    path.join(
      __dirname,
      ".runtime",
      "vimeo-extension",
      "penndbmahnpapepljikkjmakcobdahne"
    )
  )
);

function validateVimeoExtensionFiles() {
  const manifestPath = path.join(VIMEO_EXTENSION_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Vimeo downloader extension is missing: ${manifestPath}`
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Vimeo extension manifest is invalid: ${error.message}`);
  }

  if (!manifest.version || !manifest.manifest_version) {
    throw new Error("Vimeo extension manifest is incomplete");
  }

  console.log(
    `[EXTENSION] Files ready: ${VIMEO_EXTENSION_ID} v${manifest.version}`
  );
}

async function verifyLoadedVimeoExtension(browser) {
  const verificationPage = await browser.newPage();
  try {
    await verificationPage.goto(
      `chrome-extension://${VIMEO_EXTENSION_ID}/popup.html`,
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );

    const manifest = await verificationPage.evaluate(() => {
      if (!globalThis.chrome?.runtime?.getManifest) return null;
      const value = chrome.runtime.getManifest();
      return { name: value.name, version: value.version };
    });

    if (!manifest?.version) {
      throw new Error("Chrome did not expose the extension runtime");
    }

    console.log(
      `[EXTENSION] Loaded in Chrome: ${VIMEO_EXTENSION_ID} v${manifest.version}`
    );
  } catch (error) {
    throw new Error(
      `Vimeo downloader extension did not load: ${error.message}`
    );
  } finally {
    await verificationPage.close().catch(() => {});
  }
}

function sanitizeFilename(value) {
  return String(value || "").replace(/[\/\\:*?"<>|]/g, "").trim();
}

function videoDriveName(siteId, rawTitle) {
  return `[${siteId}]_${sanitizeFilename(rawTitle)}.mp4`;
}

function transcriptDriveName(siteId, rawTitle) {
  return `[${siteId}]_${sanitizeFilename(rawTitle)}_transcription.txt`;
}

function parseGoogleCredentials() {
  let credentials;
  try {
    credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google service account JSON must include client_email and private_key");
  }

  credentials.private_key = String(credentials.private_key).replace(/\\n/g, "\n");
  return credentials;
}

async function getDatabaseConnection() {
  return mysql.createConnection({
    host: requiredEnv("DB_HOST"),
    port: Number.parseInt(optionalEnv("DB_PORT", "3306"), 10),
    user: requiredEnv("DB_USER"),
    password: requiredEnv("DB_PASSWORD"),
    database: requiredEnv("DB_NAME"),
    connectTimeout: 30000,
    enableKeepAlive: true,
  });
}

async function authorize(credentials) {
  const scopes = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
  ];
  const jwtClient = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    scopes,
    GOOGLE_IMPERSONATED_USER || undefined
  );

  await jwtClient.authorize();
  return jwtClient;
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}


const SPANISH_MONTHS = new Map([
  ["enero", 0],
  ["febrero", 1],
  ["marzo", 2],
  ["abril", 3],
  ["mayo", 4],
  ["junio", 5],
  ["julio", 6],
  ["agosto", 7],
  ["septiembre", 8],
  ["setiembre", 8],
  ["octubre", 9],
  ["noviembre", 10],
  ["diciembre", 11],
]);

function normalizeForMatching(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function formatDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalDateTime(date) {
  const datePart = formatDateOnly(date);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${datePart} ${hours}:${minutes}`;
}

function validCalendarDate(year, monthIndex, day, hours = 0, minutes = 0) {
  const date = new Date(year, monthIndex, day, hours, minutes, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function parseClock(value) {
  const text = normalizeForMatching(value);
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?\b/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = (match[3] || "").replace(/[.\s]/g, "");
  if (minutes > 59 || hours > 23) return null;
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return { hours, minutes };
}

function parseDateCandidate(value) {
  if (value == null) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const original = String(value).trim();
  if (!original || /^https?:\/\//i.test(original)) return null;
  const normalized = normalizeForMatching(original);

  const spanish = normalized.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b/
  );
  if (spanish) {
    const clock = parseClock(normalized.slice(spanish.index + spanish[0].length));
    return validCalendarDate(
      Number(spanish[3]),
      SPANISH_MONTHS.get(spanish[2]),
      Number(spanish[1]),
      clock?.hours || 0,
      clock?.minutes || 0
    );
  }

  const isoDateTime = original.match(
    /\b(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/
  );
  if (isoDateTime) {
    const parsed = new Date(isoDateTime[0]);
    if (!Number.isNaN(parsed.getTime()) && /[TZ+-]/.test(isoDateTime[0].slice(10))) {
      return parsed;
    }
    return validCalendarDate(
      Number(isoDateTime[1]),
      Number(isoDateTime[2]) - 1,
      Number(isoDateTime[3]),
      Number(isoDateTime[4] || 0),
      Number(isoDateTime[5] || 0)
    );
  }

  const numeric = original.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = Number(numeric[3]);
    const clock = parseClock(original.slice((numeric.index || 0) + numeric[0].length));

    // Flor operates in Mexico; use day/month unless only month/day is valid.
    let day = first;
    let month = second;
    if (first <= 12 && second > 12) {
      day = second;
      month = first;
    }
    return validCalendarDate(
      year,
      month - 1,
      day,
      clock?.hours || 0,
      clock?.minutes || 0
    );
  }

  return null;
}

function collectScalarValues(value, pathParts = [], output = []) {
  if (value == null) return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectScalarValues(item, [...pathParts, String(index)], output)
    );
    return output;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, child]) =>
      collectScalarValues(child, [...pathParts, key], output)
    );
    return output;
  }
  output.push({ path: pathParts.join("."), value });
  return output;
}

function chooseUpcomingDate(candidates, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const maximum = new Date(today);
  maximum.setDate(maximum.getDate() + 120);

  return candidates
    .map((candidate) => ({ ...candidate, date: parseDateCandidate(candidate.value) }))
    .filter(({ date }) => date && date >= today && date <= maximum)
    .sort((a, b) => {
      const aPriority = /fecha|date|start|inicio|evento|event/i.test(a.path) ? 0 : 1;
      const bPriority = /fecha|date|start|inicio|evento|event/i.test(b.path) ? 0 : 1;
      return aPriority - bPriority || a.date - b.date;
    })[0] || null;
}

function extractPageDateCandidates(pageText) {
  const text = String(pageText || "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const focused = [];

  lines.forEach((line, index) => {
    if (/proxima|próxima|siguiente|next event|videoconferencia/i.test(line)) {
      focused.push(line, lines[index + 1] || "", lines[index + 2] || "");
    }
  });

  const source = focused.length ? focused.join("\n") : text;
  const patterns = [
    /\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+\d{4}(?:\s+(?:a\s+las\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?)?/gi,
    /\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
    /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)?)?\b/gi,
  ];

  return patterns.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => ({ path: "page_text", value: match[0] }))
  );
}

function resolveNextEventInfo(snapshot) {
  const raw = snapshot?.nextEvent ?? null;
  const scalars = collectScalarValues(raw);
  const pageCandidates = extractPageDateCandidates(snapshot?.pageText || "");
  const selectedDate = chooseUpcomingDate([...scalars, ...pageCandidates]);

  const url = scalars
    .filter(({ value }) => typeof value === "string" && /^https?:\/\//i.test(value.trim()))
    .sort((a, b) => {
      const aPriority = /zoom|url|link|enlace|meeting/i.test(a.path) ? 0 : 1;
      const bPriority = /zoom|url|link|enlace|meeting/i.test(b.path) ? 0 : 1;
      return aPriority - bPriority;
    })[0]?.value || "";

  const title = scalars.find(
    ({ path, value }) =>
      /titulo|title|nombre|name/i.test(path) &&
      typeof value === "string" &&
      !/^https?:\/\//i.test(value.trim())
  )?.value || "Próxima videoconferencia de Flor";

  const eventDate = selectedDate?.date ? new Date(selectedDate.date.getTime()) : null;
  let hasTime = Boolean(
    eventDate && (eventDate.getHours() !== 0 || eventDate.getMinutes() !== 0)
  );
  if (eventDate && !hasTime) {
    const separateClock = scalars
      .filter(({ path }) => /hora|time/i.test(path))
      .map(({ value }) => parseClock(value))
      .find(Boolean);
    if (separateClock) {
      eventDate.setHours(separateClock.hours, separateClock.minutes, 0, 0);
      hasTime = true;
    }
  }

  let status = "unresolved";
  if (eventDate && url) status = "ready";
  else if (eventDate) status = "date_only";
  else if (url) status = "url_only";
  else if (!raw) status = "no_next_event";

  return {
    date: eventDate ? formatDateOnly(eventDate) : "",
    dateTime: eventDate && hasTime ? formatLocalDateTime(eventDate) : "",
    url: String(url || ""),
    title: String(title || ""),
    checkedAt: new Date().toISOString(),
    status,
    rawPayload: JSON.stringify(raw || {}).slice(0, 12000),
  };
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

async function ensureScheduleSheet(sheets) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: WORK_LEDGER_SPREADSHEET_ID,
    fields: "sheets.properties(title)",
  });
  const exists = (metadata.data.sheets || []).some(
    (sheet) => sheet.properties?.title === WORK_LEDGER_SCHEDULE_SHEET
  );
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: WORK_LEDGER_SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: WORK_LEDGER_SCHEDULE_SHEET,
              gridProperties: { rowCount: 50, columnCount: 7, frozenRowCount: 1 },
            },
          },
        },
      ],
    },
  });
  console.log(`[SCHEDULE] Created sheet ${WORK_LEDGER_SCHEDULE_SHEET}`);
}

async function updateNextEventLedger(sheets, nextEventInfo) {
  await ensureScheduleSheet(sheets);
  const range = `${quoteSheetName(WORK_LEDGER_SCHEDULE_SHEET)}!A1:G2`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: WORK_LEDGER_SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
          "next_event_date",
          "next_event_datetime",
          "next_event_url",
          "next_event_title",
          "checked_at",
          "status",
          "raw_payload",
        ],
        [
          nextEventInfo.date,
          nextEventInfo.dateTime,
          nextEventInfo.url,
          nextEventInfo.title,
          nextEventInfo.checkedAt,
          nextEventInfo.status,
          nextEventInfo.rawPayload,
        ],
      ],
    },
  });

  console.log(
    `[SCHEDULE] Updated next event: date=${nextEventInfo.date || "unknown"} ` +
      `status=${nextEventInfo.status} url=${nextEventInfo.url ? "available" : "missing"}`
  );
}

async function findDriveFileByName(drive, filename) {
  const escapedName = escapeDriveQueryValue(filename);
  const escapedFolder = escapeDriveQueryValue(DRIVE_FOLDER_ID);
  const response = await drive.files.list({
    q: `name = '${escapedName}' and '${escapedFolder}' in parents and trashed = false`,
    fields: "files(id,name,mimeType,size,trashed,parents,webViewLink)",
    pageSize: 1,
  });
  return response.data.files?.[0] || null;
}

function isUsableDriveFile(file) {
  if (!file?.id || file.trashed) return false;
  if (file.size != null && Number(file.size) <= 0) return false;
  return true;
}

async function getDriveFileById(drive, fileId) {
  if (!hasValue(fileId)) return null;
  try {
    const response = await drive.files.get({
      fileId: String(fileId),
      fields: "id,name,mimeType,size,trashed,parents,webViewLink",
    });
    if (!isUsableDriveFile(response.data)) return null;
    return response.data;
  } catch (error) {
    const status = error?.code || error?.response?.status;
    if (status === 404) return null;
    throw error;
  }
}

function extractDriveFileId(reference) {
  const value = String(reference || "").trim();
  if (!value) return "";
  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) return value;

  const pathMatch = value.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  try {
    const parsed = new URL(value);
    const queryId = parsed.searchParams.get("id");
    if (queryId && /^[A-Za-z0-9_-]{20,}$/.test(queryId)) return queryId;
  } catch (_) {
    // Legacy local paths and malformed values are treated as stale references.
  }

  return "";
}

function canonicalDriveUrl(file) {
  if (!file?.id) return "";
  return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
}

async function downloadDriveFileToPath(drive, fileId, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.partial`;

  try {
    const response = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(temporaryPath);
      response.data.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      response.data.pipe(output);
    });

    if (!fileExistsAndNotEmpty(temporaryPath)) {
      throw new Error(`Drive download produced an empty file for ${fileId}`);
    }

    fs.renameSync(temporaryPath, destinationPath);
    console.log(`[DRIVE] Downloaded existing video to ${destinationPath}`);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (_) {}
    throw error;
  }
}

async function uploadFileToDrive(drive, filePath, filename, mimeType) {
  const existing = await findDriveFileByName(drive, filename);
  if (existing?.id) {
    console.log(`[DRIVE] Reusing existing file: ${filename}; id=${existing.id}`);
    return {
      id: existing.id,
      url: existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
    };
  }

  console.log(`[DRIVE] Uploading: ${filename}`);
  const response = await drive.files.create({
    requestBody: { name: filename, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: "id,name,webViewLink",
  });

  const fileId = response.data.id;
  if (!fileId) throw new Error(`Drive did not return an id for ${filename}`);

  console.log(`[DRIVE] Uploaded ${filename}; id=${fileId}`);
  return {
    id: fileId,
    url: response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
  };
}

const withRetry = async (
  fn,
  maxRetries = 3,
  retryDelay = 5000,
  shouldRetry = () => true
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const retryable = attempt < maxRetries && shouldRetry(error);
      if (!retryable) throw error;
      console.log(
        `[RETRY] Attempt ${attempt} failed: ${error.message}; retrying in ${retryDelay}ms`
      );
      await sleep(retryDelay);
    }
  }
  throw new Error("Retry loop exited unexpectedly");
};

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      env: process.env,
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${command} exited with ${code == null ? `signal ${signal}` : `code ${code}`}`
        )
      );
    });
  });
}

async function validateTranscriptionRuntime() {
  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
    throw new Error(`Missing transcription helper: ${TRANSCRIBE_SCRIPT}`);
  }

  await runProcess(PYTHON_BIN, [
    "-c",
    [
      "import requests",
      "from faster_whisper import WhisperModel",
      "print('[PREFLIGHT] Python transcription runtime is ready', flush=True)",
    ].join("; "),
  ]);
}

async function transcribeAudio(audioFilePath, outputPath) {
  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
    throw new Error(`Missing transcription helper: ${TRANSCRIBE_SCRIPT}`);
  }

  await runProcess(PYTHON_BIN, [
    TRANSCRIBE_SCRIPT,
    "--input",
    audioFilePath,
    "--output",
    outputPath,
  ]);

  if (!fileExistsAndNotEmpty(outputPath)) {
    throw new Error("faster-whisper completed without creating a transcript");
  }

  return fs.readFileSync(outputPath, "utf8").trim();
}

// ------------------------------ DIAGNOSTICS ------------------------------

async function takeScreenshot(page, outPath) {
  try {
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`[DIAG] Screenshot saved: ${outPath}`);
  } catch (e) {
    console.log("[DIAG] Screenshot failed:", e.message);
  }
}

async function dumpSmallDomSample(frame, label) {
  try {
    const info = await frame.evaluate(() => {
      const htmlLen =
        document.documentElement && document.documentElement.outerHTML
          ? document.documentElement.outerHTML.length
          : -1;
      const classes = Array.from(document.querySelectorAll("[class]"))
        .slice(0, 40)
        .map((x) => x.className)
        .join(" | ");
      const ids = Array.from(document.querySelectorAll("[id]"))
        .slice(0, 40)
        .map((x) => x.id)
        .join(" | ");
      return { url: location.href, htmlLen, sampleClasses: classes, sampleIds: ids };
    });
    console.log(`[DIAG] ${label} DOM:`, info);
  } catch (e) {
    console.log(`[DIAG] ${label} DOM fetch failed:`, e.message);
  }
}

// ------------------------------ Vimeo: programmatic resolve ------------------------------

async function extractVimeoFrame(page) {
  const sel = 'iframe[src*="vimeo.com"]';
  await page.waitForSelector(sel, { timeout: 30000 });
  const handle = await page.$(sel);
  if (!handle) return null;
  const src = await handle.evaluate((n) => n.src);
  const frame = await handle.contentFrame();
  return { frame, src };
}

function chooseLowestVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  let best = null;
  for (const v of variants) {
    const h = isFinite(v.height) ? v.height : Infinity;
    if (!best || h < best.height) best = { url: v.url, height: h };
  }
  return best;
}

function downloadFileHttps(url, destPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        return downloadFileHttps(res.headers.location, destPath, headers).then(
          resolve,
          reject
        );
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("error", (err) => {
      try {
        fs.unlinkSync(destPath);
      } catch {}
      reject(err);
    });
  });
}

function downloadHlsWithFfmpeg(hlsUrl, outPath, referer) {
  const headerLines = [
    `Referer: ${referer}`,
    `Origin: https://player.vimeo.com`,
    `User-Agent: Mozilla/5.0`,
  ].join("\r\n") + "\r\n";

  return new Promise((resolve, reject) => {
    ffmpegCli(hlsUrl)
      .inputOptions([
        "-headers",
        headerLines,
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
      ])
      .outputOptions(["-c", "copy"])
      .on("progress", (p) => {
        if (p && typeof p.percent === "number") {
          const pct = Math.max(0, Math.min(100, Math.round(p.percent)));
          if (pct % 10 === 0) console.log(`[FFMPEG] ${pct}%`);
        }
      })
      .on("end", () => resolve())
      .on("error", (err, _stdout, stderr) => {
        try {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch {}
        console.error("[FFMPEG][ERR]", err && err.message ? err.message : err);
        if (stderr) console.error("[FFMPEG][STDERR]", String(stderr).slice(0, 2000));
        reject(err);
      })
      .save(outPath);
  });
}

/**
 * Read the download URLs injected by the installed Vimeo downloader extension.
 * This is the primary resolver because the original local Puppeteer profile
 * depended on that extension being installed.
 */
async function resolveVimeoStreamsFromExtension(vimeoFrame, timeoutMs = 25000) {
  try {
    await vimeoFrame.waitForFunction(
      () =>
        document.body?.getAttribute("inject_vt_svd") ||
        document.querySelector(
          ".__vt-svd-group__, .__vt-svd-download__, .vt-web-download[hlsurl]"
        ),
      { timeout: timeoutMs, polling: 500 }
    );
  } catch {
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resolved = await vimeoFrame.evaluate(() => {
      const qualityFrom = (...values) => {
        const text = values.filter(Boolean).join(" ");
        const match = text.match(/(?:^|\D)(\d{3,4})p?(?:\D|$)/i);
        return match ? Number.parseInt(match[1], 10) : Infinity;
      };

      const progressive = Array.from(
        document.querySelectorAll(".__vt-svd-download__ a[href]")
      )
        .map((anchor) => ({
          url: anchor.href,
          height: qualityFrom(
            anchor.textContent,
            anchor.title,
            anchor.getAttribute("download"),
            anchor.id
          ),
        }))
        .filter(
          (item) =>
            /^https?:\/\//i.test(item.url) &&
            !/chrome-extension:/i.test(item.url)
        );

      const hlsVariants = Array.from(
        document.querySelectorAll(".vt-web-download[hlsurl]")
      )
        .map((element) => ({
          url: element.getAttribute("hlsurl") || "",
          height: qualityFrom(
            element.getAttribute("qid"),
            element.textContent,
            element.title
          ),
        }))
        .filter((item) => /^https?:\/\//i.test(item.url));

      return {
        referer: location.href,
        progressive,
        hlsVariants,
      };
    });

    if (resolved.progressive.length || resolved.hlsVariants.length) {
      const lowestHls = resolved.hlsVariants
        .slice()
        .sort((left, right) => left.height - right.height)[0];
      return {
        source: "extension",
        referer: resolved.referer,
        progressive: resolved.progressive,
        hlsMaster: lowestHls?.url || null,
        hlsVariants: resolved.hlsVariants,
      };
    }

    await sleep(500);
  }

  return null;
}

/**
 * Try to capture the signed config JSON from any network response (not just XHR/fetch).
 */
async function awaitVimeoConfigFromNetworkBroad(page, timeoutMs = 10000) {
  try {
    const resp = await page.waitForResponse(
      (r) => {
        const u = r.url();
        return u.includes("player.vimeo.com") && /\/video\/\d+\/config\b/.test(u);
      },
      { timeout: timeoutMs }
    );
    const ct = resp.headers()["content-type"] || "";
    if (!/json/i.test(ct)) {
      const t = await resp.text().catch(() => "");
      if (t.trim().startsWith("{") || t.trim().startsWith("[")) {
        try {
          return JSON.parse(t);
        } catch {
          return null;
        }
      }
      return null;
    }
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Extract JSON embedded in a <script> tag that contains `"request":{"files":...}`
 * Naive brace matching to recover object even if minified.
 */
function extractEmbeddedPlayerJson(html) {
  const key = '"request":{"files":';
  const idx = html.indexOf(key);
  if (idx < 0) return null;
  let start = idx;
  while (start >= 0 && html[start] !== "{") start--;
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let strQuote = "";
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === strQuote) {
        inStr = false;
        strQuote = "";
      }
      continue;
    } else {
      if (ch === '"' || ch === "'") {
        inStr = true;
        strQuote = ch;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = html.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch (_) {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Resolve Vimeo streams from inside the iframe, preferring embedded JSON.
 */
async function resolveVimeoStreams(page, vimeoFrame) {
  const embedded = await vimeoFrame.evaluate(async () => {
    function decodeEntities(s) {
      return String(s || "")
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/gi, "&")
        .replace(/\\\//g, "/");
    }
    function buildFromConfig(j) {
      const out = { referer: location.href, hlsMaster: null, hlsVariants: [], progressive: [] };
      const hls = j?.request?.files?.hls;
      if (hls) {
        const def = hls.default_cdn || Object.keys(hls.cdns || {})[0];
        out.hlsMaster =
          (hls.cdns && hls.cdns[def] && hls.cdns[def].url) || hls.url || null;
      }
      const prog = j?.request?.files?.progressive;
      if (Array.isArray(prog)) {
        out.progressive = prog
          .map((p) => ({ url: p.url, height: p.height || Infinity }))
          .filter((x) => !!x.url);
      }
      return out;
    }

    try {
      const node = document.querySelector("[data-config]");
      if (node) {
        const raw = node.getAttribute("data-config") || "";
        const jsonText = decodeEntities(raw);
        if (jsonText.trim().startsWith("{")) {
          const j = JSON.parse(jsonText);
          return { ok: true, data: buildFromConfig(j) };
        }
      }
    } catch {}

    try {
      const html =
        document.documentElement?.innerHTML?.replace(/&quot;/g, '"').replace(/&amp;/g, "&") ||
        "";
      const mSigned = html.match(
        /"config_url":"(https?:\\u002F\\u002Fplayer\.vimeo\.com\\u002Fvideo\\u002F\d+\\u002Fconfig[^"]+)"/i
      );
      if (mSigned && mSigned[1]) {
        const signedUrl = decodeEntities(mSigned[1]);
        const r = await fetch(signedUrl, {
          credentials: "include",
          headers: { accept: "application/json" },
        });
        const t = await r.text();
        if (r.ok) {
          const j = JSON.parse(t);
          return { ok: true, data: buildFromConfig(j) };
        }
      }

      const j = (function extractJsonWithFiles(body) {
        const needle = '"request":{"files":';
        const idx = body.indexOf(needle);
        if (idx < 0) return null;
        let s = idx;
        while (s >= 0 && body[s] !== "{") s--;
        if (s < 0) return null;
        let depth = 0,
          inStr = false,
          q = "",
          esc = false;
        for (let i = s; i < body.length; i++) {
          const ch = body[i];
          if (inStr) {
            if (esc) {
              esc = false;
              continue;
            }
            if (ch === "\\") {
              esc = true;
              continue;
            }
            if (ch === q) {
              inStr = false;
              q = "";
              continue;
            }
            continue;
          } else {
            if (ch === '"' || ch === "'") {
              inStr = true;
              q = ch;
              continue;
            }
            if (ch === "{") depth++;
            if (ch === "}") {
              depth--;
              if (depth === 0) {
                const slice = body.slice(s, i + 1);
                try {
                  return JSON.parse(slice);
                } catch {
                  return null;
                }
              }
            }
          }
        }
        return null;
      })(html);
      if (j) return { ok: true, data: buildFromConfig(j) };
    } catch {}

    return { ok: false };
  });

  if (embedded && embedded.ok) return embedded.data;

  const net = await awaitVimeoConfigFromNetworkBroad(page, 8000);
  if (net && net.request && net.request.files) {
    const out = {
      referer: "https://player.vimeo.com/",
      hlsMaster: null,
      hlsVariants: [],
      progressive: [],
    };
    const hls = net.request.files.hls;
    if (hls) {
      const def = hls.default_cdn || Object.keys(hls.cdns || {})[0];
      out.hlsMaster =
        (hls.cdns && hls.cdns[def] && hls.cdns[def].url) || hls.url || null;
    }
    const prog = net.request.files.progressive;
    if (Array.isArray(prog)) {
      out.progressive = prog
        .map((p) => ({ url: p.url, height: p.height || Infinity }))
        .filter((x) => !!x.url);
    }
    return out;
  }

  throw new Error(
    "Could not resolve Vimeo streams (no embedded JSON / no network config)"
  );
}

// ------------------------------ RESUMABLE PIPELINE HELPERS ------------------------------

function safeErrorMessage(error) {
  return error?.stack || error?.message || String(error);
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim();
  return normalized !== "" && normalized.toLowerCase() !== "null" && normalized.toLowerCase() !== "undefined";
}

function fileExistsAndNotEmpty(filePath) {
  try {
    return hasValue(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }
  return "";
}

function firstExistingPath(...paths) {
  for (const candidate of paths) {
    if (fileExistsAndNotEmpty(candidate)) return candidate;
  }
  return "";
}

function toDbValue(value) {
  return hasValue(value) ? String(value) : "";
}

function toNullableDbValue(value) {
  return hasValue(value) ? String(value) : null;
}

function walkFiles(rootDir) {
  const out = [];
  if (!rootDir || !fs.existsSync(rootDir)) return out;

  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) out.push(fullPath);
    }
  }
  return out;
}

function newestExisting(files) {
  return (
    files
      .filter(fileExistsAndNotEmpty)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || ""
  );
}

function findLatestVideoFile(siteId) {
  const id = String(siteId);
  return newestExisting(
    walkFiles(FILES_DIR).filter((filePath) => {
      const basename = path.basename(filePath);
      return basename.startsWith(`[${id}]_`) && basename.toLowerCase().endsWith(".mp4");
    })
  );
}

function findLatestAudioFile(siteId) {
  const id = String(siteId);
  return newestExisting(
    walkFiles(FILES_DIR).filter((filePath) => {
      const basename = path.basename(filePath);
      return basename.startsWith(`${id}_audio_`) && basename.toLowerCase().endsWith(".mp3");
    })
  );
}

function findLatestTranscriptFile(siteId) {
  const id = String(siteId);
  return newestExisting(
    walkFiles(FILES_DIR).filter(
      (filePath) => path.basename(filePath) === `${id}_transcription.txt`
    )
  );
}

function findLatestProgressManifest(siteId) {
  const id = String(siteId);
  const manifestPath = newestExisting(
    walkFiles(FILES_DIR).filter(
      (filePath) => path.basename(filePath) === `${id}_progress.json`
    )
  );
  if (!manifestPath) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    parsed.__manifestPath = manifestPath;
    return parsed;
  } catch {
    return null;
  }
}

function getOutputDirFromState(state) {
  const candidates = [
    state.outputDir,
    state.savePath && path.dirname(state.savePath),
    state.processedAudio && path.dirname(state.processedAudio),
    state.transcriptionFilePath && path.dirname(state.transcriptionFilePath),
  ].filter(hasValue);

  if (candidates.length) return candidates[0];
  return path.join(FILES_DIR, `scrapeData_${Date.now()}`);
}

function writeProgressManifest(state) {
  try {
    const outputDir = getOutputDirFromState(state);
    fs.mkdirSync(outputDir, { recursive: true });
    state.outputDir = outputDir;

    const progressPath = path.join(outputDir, `${state.siteId}_progress.json`);
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          siteId: state.siteId,
          rawTitle: state.rawTitle,
          saveName: state.saveName || "",
          savePath: state.savePath || "",
          driveFileId: state.driveFileId || "",
          processedAudio: state.processedAudio || "",
          transcriptionFilePath: state.transcriptionFilePath || "",
          transcriptionReference: state.transcriptionReference || "",
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(`[PROGRESS][WARN] Could not write manifest: ${error.message}`);
  }
}

async function getVideoRecord(siteId, videoTitle) {
  const connection = await getDatabaseConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT id, google_file_id, transcription_path, audio_path, video_title, summary
       FROM videos
       WHERE id = ? OR LOWER(video_title) = LOWER(?)
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      [siteId, videoTitle, siteId]
    );
    return rows[0] || null;
  } finally {
    await connection.end();
  }
}

async function saveVideoProgress(siteId, videoTitle, state, existingRecord = null) {
  const connection = await getDatabaseConnection();
  try {
    let record = existingRecord;
    if (!record) {
      const [rows] = await connection.execute(
        `SELECT id, google_file_id, transcription_path, audio_path, video_title, summary
         FROM videos
         WHERE id = ? OR LOWER(video_title) = LOWER(?)
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
        [siteId, videoTitle, siteId]
      );
      record = rows[0] || null;
    }

    const next = {
      // The reconciled state is authoritative. google_file_id uses SQL NULL
      // while missing because it has a unique index. The legacy text columns
      // remain empty strings because the production schema marks them NOT NULL.
      googleFileId: state.driveFileId,
      transcriptionPath: state.transcriptionReference,
      audioPath: firstValue(record?.audio_path),
      title: firstValue(videoTitle, record?.video_title),
      summary: firstValue(record?.summary),
    };

    if (record) {
      await connection.execute(
        `UPDATE videos
         SET google_file_id = ?, transcription_path = ?, audio_path = ?, video_title = ?, summary = ?
         WHERE id = ?`,
        [
          toNullableDbValue(next.googleFileId),
          toDbValue(next.transcriptionPath),
          toDbValue(next.audioPath),
          toDbValue(next.title),
          toDbValue(next.summary),
          record.id,
        ]
      );
      console.log(`[DB] Progress updated for ${record.id}`);
    } else if (!hasValue(next.googleFileId)) {
      // Do not create a placeholder row with google_file_id=''. The video is
      // downloaded/uploaded first, and the row is inserted on the next save.
      console.log(`[DB] Insert deferred for ${siteId}; Drive video ID is not ready`);
    } else {
      await connection.execute(
        `INSERT INTO videos
          (id, google_file_id, transcription_path, audio_path, video_title, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          siteId,
          toNullableDbValue(next.googleFileId),
          toDbValue(next.transcriptionPath),
          toDbValue(next.audioPath),
          toDbValue(next.title),
          toDbValue(next.summary),
        ]
      );
      console.log(`[DB] Progress inserted for ${siteId}`);
    }
  } finally {
    await connection.end();
  }
}

function buildInitialState(siteId, rawTitle, record, manifest) {
  const foundVideo = findLatestVideoFile(siteId);
  const foundAudio = findLatestAudioFile(siteId);
  const foundTranscript = findLatestTranscriptFile(siteId);

  return {
    siteId,
    rawTitle,
    outputDir: firstValue(
      manifest?.outputDir,
      manifest?.__manifestPath && path.dirname(manifest.__manifestPath)
    ),
    saveName: firstValue(manifest?.saveName),
    savePath: firstExistingPath(manifest?.savePath, foundVideo),
    driveFileId: firstValue(record?.google_file_id, manifest?.driveFileId),
    processedAudio: firstExistingPath(manifest?.processedAudio, foundAudio),
    transcriptionFilePath: firstExistingPath(
      manifest?.transcriptionFilePath,
      foundTranscript
    ),
    transcriptionReference: firstValue(
      record?.transcription_path,
      manifest?.transcriptionReference
    ),
  };
}

async function resolveAndDownloadVideo(page, siteId, rawTitle, state) {
  await page.goto(`${VIDEOS_URL}/${siteId}`, {
    waitUntil: "domcontentloaded",
  });

  const info = await extractVimeoFrame(page);
  if (!info || !info.frame) {
    await dumpSmallDomSample(page.mainFrame(), "Top");
    await takeScreenshot(page, `diag_no_iframe_${siteId}.png`);
    throw new Error("No Vimeo iframe found on page");
  }
  const vimeoFrame = info.frame;

  // Keep the extension loaded for parity with the original browser profile,
  // but resolve and choose the media exactly as the supplied reference script:
  // signed Vimeo config -> HLS first -> lowest HLS variant -> progressive fallback.
  const resolved = await resolveVimeoStreams(page, vimeoFrame);
  if (
    !resolved ||
    (!resolved.hlsMaster && (!resolved.progressive || resolved.progressive.length === 0))
  ) {
    await dumpSmallDomSample(vimeoFrame, "Iframe");
    throw new Error("Could not resolve Vimeo streams (no HLS/progressive)");
  }

  let chosenUrl = null;
  if (resolved.hlsMaster) {
    try {
      const text = await vimeoFrame.evaluate(
        async (master, ref) => {
          const r = await fetch(master, {
            credentials: "include",
            headers: { Referer: ref },
          });
          return await r.text();
        },
        resolved.hlsMaster,
        resolved.referer || "https://player.vimeo.com/"
      );
      const lines = String(text || "").split("\n");
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        const L = (lines[i] || "").trim();
        if (L.startsWith("#EXT-X-STREAM-INF")) {
          const mh = L.match(/RESOLUTION=\s*(\d+)\s*x\s*(\d+)/i);
          const height = mh ? parseInt(mh[2], 10) : Infinity;
          const next = (lines[i + 1] || "").trim();
          if (next && !next.startsWith("#")) {
            const abs = new URL(next, resolved.hlsMaster).toString();
            variants.push({ url: abs, height });
          }
        }
      }
      const low = chooseLowestVariant(variants);
      chosenUrl = low ? low.url : resolved.hlsMaster;
      console.log(`[STREAM] Using HLS (${low ? `${low.height}p` : "master"})`);
    } catch {
      chosenUrl = resolved.hlsMaster;
      console.log("[STREAM] Using HLS (master, variant parse failed)");
    }
  } else if (resolved.progressive && resolved.progressive.length) {
    const low = chooseLowestVariant(resolved.progressive);
    chosenUrl = low.url;
    console.log(
      `[STREAM] Using progressive MP4 (${isFinite(low.height) ? `${low.height}p` : "unknown"})`
    );
  }

  if (!chosenUrl) throw new Error("No usable stream URL found");

  const outputDir = getOutputDirFromState(state);
  fs.mkdirSync(outputDir, { recursive: true });
  const saveName = videoDriveName(siteId, rawTitle);
  const savePath = path.join(outputDir, saveName);

  if (chosenUrl.includes("m3u8")) {
    await downloadHlsWithFfmpeg(
      chosenUrl,
      savePath,
      resolved.referer || "https://player.vimeo.com/"
    );
  } else {
    await downloadFileHttps(chosenUrl, savePath, {
      Referer: resolved.referer || "https://player.vimeo.com/",
    });
  }

  state.outputDir = outputDir;
  state.saveName = saveName;
  state.savePath = savePath;
  console.log(`[DOWNLOAD] Saved: ${savePath}`);
  writeProgressManifest(state);
}

async function processAudioFromVideo(state) {
  if (!fileExistsAndNotEmpty(state.savePath)) {
    throw new Error("Cannot process audio because local video is missing");
  }

  const outputDir = getOutputDirFromState(state);
  fs.mkdirSync(outputDir, { recursive: true });
  const processedAudio = path.join(
    outputDir,
    `${state.siteId}_audio_${Date.now()}.mp3`
  );

  await new Promise((resolve, reject) => {
    ffmpegCli(state.savePath)
      .audioCodec("libmp3lame")
      .audioBitrate(32)
      .audioChannels(1)
      .audioFrequency(16000)
      .format("mp3")
      .audioFilters("silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-40dB")
      .on("end", resolve)
      .on("error", reject)
      .save(processedAudio);
  });

  state.outputDir = outputDir;
  state.processedAudio = processedAudio;
  console.log(`[AUDIO] Saved: ${processedAudio}`);
  writeProgressManifest(state);
}

async function ensureTranscript(drive, state, record) {
  if (hasValue(state.transcriptionReference)) {
    console.log(`[TRANSCRIPT] Existing reference: ${state.transcriptionReference}`);
    return;
  }

  if (!fileExistsAndNotEmpty(state.processedAudio)) {
    console.log(`[TRANSCRIPT] Skipped ${state.siteId}; audio is missing`);
    return;
  }

  const outputDir = getOutputDirFromState(state);
  fs.mkdirSync(outputDir, { recursive: true });
  state.transcriptionFilePath = path.join(
    outputDir,
    `${state.siteId}_transcription.txt`
  );

  if (!fileExistsAndNotEmpty(state.transcriptionFilePath)) {
    await transcribeAudio(state.processedAudio, state.transcriptionFilePath);
    console.log(`[TRANSCRIPT] Local file saved: ${state.transcriptionFilePath}`);
  }

  const transcriptName = transcriptDriveName(state.siteId, state.rawTitle);
  const uploaded = await withRetry(
    () =>
      uploadFileToDrive(
        drive,
        state.transcriptionFilePath,
        transcriptName,
        "text/plain"
      ),
    3,
    10000
  );

  state.transcriptionReference = uploaded.url;
  writeProgressManifest(state);
  await saveVideoProgress(state.siteId, state.rawTitle, state, record);
  console.log(`[TRANSCRIPT] Persistent reference saved: ${uploaded.url}`);
}

async function processOneVideo(page, drive, video) {
  const rawTitle = video.Titulo || "";
  const siteId = video.id;
  console.log(`[VIDEO] Processing ${siteId} "${rawTitle}"`);

  const record = await getVideoRecord(siteId, rawTitle);
  const manifest = findLatestProgressManifest(siteId);
  const state = buildInitialState(siteId, rawTitle, record, manifest);
  const expectedVideoName = videoDriveName(siteId, rawTitle);
  const expectedTranscriptName = transcriptDriveName(siteId, rawTitle);

  // Reconcile the video independently. A non-empty DB field is not considered
  // healthy until the Drive file is proven to exist.
  let remoteVideo = null;
  if (hasValue(state.driveFileId)) {
    remoteVideo = await getDriveFileById(drive, state.driveFileId);
    if (!remoteVideo) {
      console.log(`[REPAIR] Stale video reference for ${siteId}; searching Drive by name`);
      state.driveFileId = "";
    }
  }

  if (!remoteVideo) {
    remoteVideo = await findDriveFileByName(drive, expectedVideoName);
    if (remoteVideo?.id) {
      state.driveFileId = remoteVideo.id;
      console.log(`[REPAIR] Recovered video reference for ${siteId}`);
    }
  }

  // Reconcile the transcript independently. Legacy local paths, malformed URLs,
  // and deleted Drive files are treated as missing and regenerated.
  let remoteTranscript = null;
  const transcriptFileId = extractDriveFileId(state.transcriptionReference);
  if (transcriptFileId) {
    remoteTranscript = await getDriveFileById(drive, transcriptFileId);
    if (!remoteTranscript) {
      console.log(`[REPAIR] Stale transcript reference for ${siteId}; searching Drive by name`);
      state.transcriptionReference = "";
    }
  } else if (hasValue(state.transcriptionReference)) {
    console.log(`[REPAIR] Invalid transcript reference for ${siteId}; rebuilding it`);
    state.transcriptionReference = "";
  }

  if (!remoteTranscript) {
    remoteTranscript = await findDriveFileByName(drive, expectedTranscriptName);
    if (remoteTranscript?.id) {
      state.transcriptionReference = canonicalDriveUrl(remoteTranscript);
      console.log(`[REPAIR] Recovered transcript reference for ${siteId}`);
    }
  } else {
    state.transcriptionReference = canonicalDriveUrl(remoteTranscript);
  }

  // Persist repaired references, including deliberate clearing of stale values.
  await saveVideoProgress(siteId, rawTitle, state, record);

  const hasPersistentVideo = Boolean(remoteVideo?.id);
  const hasPersistentTranscript = Boolean(remoteTranscript?.id);

  if (hasPersistentVideo && hasPersistentTranscript) {
    console.log(`[VIDEO] [HEALTHY] ${siteId} has a valid video and transcript`);
    return;
  }

  // Guarantee a local video only when a downstream stage needs it. Prefer the
  // already-uploaded Drive copy; scrape Flor only when no persistent copy exists.
  if (!fileExistsAndNotEmpty(state.savePath)) {
    const outputDir = getOutputDirFromState(state);
    fs.mkdirSync(outputDir, { recursive: true });
    state.outputDir = outputDir;
    state.saveName = expectedVideoName;
    state.savePath = path.join(outputDir, expectedVideoName);

    if (hasPersistentVideo) {
      await withRetry(
        () => downloadDriveFileToPath(drive, remoteVideo.id, state.savePath),
        3,
        10000
      );
      writeProgressManifest(state);
    } else {
      await resolveAndDownloadVideo(page, siteId, rawTitle, state);
    }
  } else {
    console.log(`[DOWNLOAD] Existing local video: ${state.savePath}`);
  }

  if (!hasPersistentVideo && fileExistsAndNotEmpty(state.savePath)) {
    const uploadedVideo = await withRetry(
      () =>
        uploadFileToDrive(
          drive,
          state.savePath,
          expectedVideoName,
          "video/mp4"
        ),
      3,
      10000
    );
    state.driveFileId = uploadedVideo.id;
    remoteVideo = await getDriveFileById(drive, uploadedVideo.id);
    writeProgressManifest(state);
    await saveVideoProgress(siteId, rawTitle, state, record);
  }

  if (!hasPersistentTranscript) {
    if (!fileExistsAndNotEmpty(state.processedAudio)) {
      await processAudioFromVideo(state);
    }
    await ensureTranscript(drive, state, record);
  }

  writeProgressManifest(state);
  await saveVideoProgress(siteId, rawTitle, state, record);
  console.log(`[VIDEO] Finished repair pass for ${siteId}`);
}

// ------------------------------ MAIN ------------------------------

async function scrapeData(limit = MAX_VIDEOS) {
  console.log(
    limit === 0
      ? "[START] One-shot repair run; checking all available videos"
      : `[START] One-shot repair run; checking latest ${limit} videos`
  );

  // Fail before opening Flor, changing ledger state, or downloading media
  // when the disposable runner is missing a required runtime dependency.
  await validateTranscriptionRuntime();
  validateVimeoExtensionFiles();

  if (HEADLESS) {
    throw new Error(
      "PUPPETEER_HEADLESS must be false because Chrome extensions require a headed browser under Xvfb"
    );
  }

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    defaultViewport: { width: 1440, height: 1000 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--disable-extensions-except=${VIMEO_EXTENSION_DIR}`,
      `--load-extension=${VIMEO_EXTENSION_DIR}`,
    ],
  });

  let hadItemFailures = false;
  let scheduleFailure = null;
  try {
    await verifyLoadedVimeoExtension(browser);
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    page.on("console", (message) => {
      const text = message.text();
      if (/vimeo|merge|ffmpeg|m3u8|download|config_url|data-config/i.test(text)) {
        console.log(`[BROWSER] ${text}`);
      }
    });

    const jwtClient = await authorize(parseGoogleCredentials());
    const drive = google.drive({ version: "v3", auth: jwtClient });
    const sheets = google.sheets({ version: "v4", auth: jwtClient });
    console.log("[GOOGLE] Authorized");

    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    console.log("[LOGIN] Navigating to login");
    await page.goto(`${SITE_BASE_URL}/login`, { waitUntil: "domcontentloaded" });

    await page.evaluate(() => {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => registrations.forEach((registration) => registration.unregister()));
      }
    });

    const allInputs = await page.$$("input:not([disabled])");
    const passwordInputs = await page.$$("input[type='password']:not([disabled])");
    if (!passwordInputs.length) throw new Error("No password input found");
    const passwordInput = passwordInputs[0];

    let passwordIndex = -1;
    for (let index = 0; index < allInputs.length; index += 1) {
      const type = await allInputs[index].evaluate((node) => node.type);
      if (type === "password") {
        passwordIndex = index;
        break;
      }
    }

    const usernameInput =
      passwordIndex > 0
        ? allInputs[passwordIndex - 1]
        : await page.$("input[type='text']:not([disabled])");
    if (!usernameInput) throw new Error("No username input found");

    await usernameInput.click({ clickCount: 3 });
    await usernameInput.press("Backspace");
    await page.keyboard.type(USERNAME, { delay: 20 });

    await passwordInput.click({ clickCount: 3 });
    await passwordInput.press("Backspace");
    await page.keyboard.type(PASSWORD, { delay: 20 });

    const submitButton = await page.$(".btn-morado");
    if (!submitButton) throw new Error("No .btn-morado submit button found");

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }),
      submitButton.click(),
    ]);
    console.log("[LOGIN] OK");

    console.log("[VIDEOS] Loading list");
    await page.goto(VIDEOS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      "window.__NUXT__ && window.__NUXT__.data && window.__NUXT__.data[0] && window.__NUXT__.data[0].videoconferencias",
      { timeout: 20000 }
    );

    const nextEventSnapshot = await page.evaluate(() => ({
      nextEvent: window.__NUXT__?.data?.[0]?.nextEvent || null,
      pageText: document.body?.innerText || "",
    }));
    const nextEventInfo = resolveNextEventInfo(nextEventSnapshot);
    try {
      await updateNextEventLedger(sheets, nextEventInfo);
    } catch (error) {
      scheduleFailure = error;
      console.error(`[SCHEDULE][ERROR] ${safeErrorMessage(error)}`);
    }

    let videoconferencias = await page.evaluate(
      () => window.__NUXT__.data[0].videoconferencias
    );
    videoconferencias = videoconferencias.reverse();
    if (limit > 0) videoconferencias = videoconferencias.slice(0, limit);
    console.log(`[VIDEOS] Found ${videoconferencias.length} candidate items`);

    for (const video of videoconferencias) {
      try {
        await processOneVideo(page, drive, video);
      } catch (error) {
        hadItemFailures = true;
        console.error(
          `[VIDEO][ERROR] ${video?.id || "unknown"} "${video?.Titulo || ""}": ${safeErrorMessage(error)}`
        );
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (hadItemFailures || scheduleFailure) {
    const failures = [];
    if (hadItemFailures) failures.push("one or more videos failed");
    if (scheduleFailure) failures.push("the next-event ledger update failed");
    throw new Error(`${failures.join("; ")}; the next run will retry`);
  }
}

scrapeData()
  .then(() => {
    console.log("[DONE] GitHub Actions worker finished successfully");
  })
  .catch((error) => {
    console.error("[RUN][ERROR]", safeErrorMessage(error));
    process.exitCode = 1;
  });
