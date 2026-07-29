// script.js
// One-shot GitHub Actions worker for Flor videoconferences.
// Discovers and downloads Vimeo recordings, uploads the video to Google Drive,
// extracts audio, transcribes locally with faster-whisper, uploads the transcript,
// and records progress in the existing MySQL videos table.

"use strict";

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

let ffmpegInstallerPath = null;
try {
  ffmpegInstallerPath = require("@ffmpeg-installer/ffmpeg").path;
  if (ffmpegInstallerPath) ffmpegCli.setFfmpegPath(ffmpegInstallerPath);
} catch (_) {
  // System ffmpeg must be in PATH.
}

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

const USERNAME = requiredEnv("FLOR_USERNAME");
const PASSWORD = requiredEnv("FLOR_PASSWORD");
const SITE_BASE_URL = optionalEnv("FLOR_SITE_BASE_URL", "https://buenainfancia.com.mx").replace(/\/$/, "");
const VIDEOS_URL = `${SITE_BASE_URL}/videoconferencias`;

const PYTHON_BIN = optionalEnv("PYTHON_BIN", "python3");
const TRANSCRIBE_SCRIPT = path.resolve(__dirname, "transcribe.py");
const MAX_VIDEOS = Math.max(1, Number.parseInt(optionalEnv("MAX_VIDEOS", "30"), 10) || 30);
const HEADLESS = optionalEnv("PUPPETEER_HEADLESS", "true").toLowerCase() !== "false";

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
  const scopes = ["https://www.googleapis.com/auth/drive"];
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

async function findDriveFileByName(drive, filename) {
  const escapedName = escapeDriveQueryValue(filename);
  const escapedFolder = escapeDriveQueryValue(DRIVE_FOLDER_ID);
  const response = await drive.files.list({
    q: `name = '${escapedName}' and '${escapedFolder}' in parents and trashed = false`,
    fields: "files(id,name,webViewLink)",
    pageSize: 1,
  });
  return response.data.files?.[0] || null;
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
  ].join("\r\n");

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
        console.error("[FFMPEG][ERR]", err && err.message ? err.message : err);
        if (stderr) console.error("[FFMPEG][STDERR]", String(stderr).slice(0, 2000));
        reject(err);
      })
      .save(outPath);
  });
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
      googleFileId: firstValue(state.driveFileId, record?.google_file_id),
      transcriptionPath: firstValue(
        state.transcriptionReference,
        record?.transcription_path
      ),
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
          toDbValue(next.googleFileId),
          toDbValue(next.transcriptionPath),
          toDbValue(next.audioPath),
          toDbValue(next.title),
          toDbValue(next.summary),
          record.id,
        ]
      );
      console.log(`[DB] Progress updated for ${record.id}`);
    } else {
      await connection.execute(
        `INSERT INTO videos
          (id, google_file_id, transcription_path, audio_path, video_title, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          siteId,
          toDbValue(next.googleFileId),
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
  await page.goto(`${VIDEOS_URL}/${siteId}`, { waitUntil: "domcontentloaded" });

  const info = await extractVimeoFrame(page);
  if (!info?.frame) {
    await dumpSmallDomSample(page.mainFrame(), "Top");
    await takeScreenshot(page, `diag_no_iframe_${siteId}.png`);
    throw new Error("No Vimeo iframe found on page");
  }

  const vimeoFrame = info.frame;
  const resolved = await resolveVimeoStreams(page, vimeoFrame);
  if (!resolved || (!resolved.hlsMaster && !resolved.progressive?.length)) {
    await dumpSmallDomSample(vimeoFrame, "Iframe");
    throw new Error("Could not resolve Vimeo streams (no HLS/progressive)");
  }

  let chosenUrl = null;
  if (resolved.hlsMaster) {
    try {
      const text = await vimeoFrame.evaluate(
        async (master, referer) => {
          const response = await fetch(master, {
            credentials: "include",
            headers: { Referer: referer },
          });
          return response.text();
        },
        resolved.hlsMaster,
        resolved.referer || "https://player.vimeo.com/"
      );

      const lines = String(text || "").split("\n");
      const variants = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] || "").trim();
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

        const resolution = line.match(/RESOLUTION=\s*(\d+)\s*x\s*(\d+)/i);
        const height = resolution ? Number.parseInt(resolution[2], 10) : Infinity;
        const nextLine = (lines[index + 1] || "").trim();
        if (nextLine && !nextLine.startsWith("#")) {
          variants.push({
            url: new URL(nextLine, resolved.hlsMaster).toString(),
            height,
          });
        }
      }

      const lowest = chooseLowestVariant(variants);
      chosenUrl = lowest?.url || resolved.hlsMaster;
      console.log(`[STREAM] Using HLS (${lowest ? `${lowest.height}p` : "master"})`);
    } catch {
      chosenUrl = resolved.hlsMaster;
      console.log("[STREAM] Using HLS master; variant parsing failed");
    }
  } else {
    const lowest = chooseLowestVariant(resolved.progressive);
    chosenUrl = lowest?.url || null;
    console.log(
      `[STREAM] Using progressive MP4 (${Number.isFinite(lowest?.height) ? `${lowest.height}p` : "unknown"})`
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

  let recoveredDriveState = false;
  if (!hasValue(state.driveFileId)) {
    const existingVideo = await findDriveFileByName(
      drive,
      videoDriveName(siteId, rawTitle)
    );
    if (existingVideo?.id) {
      state.driveFileId = existingVideo.id;
      recoveredDriveState = true;
      console.log(`[DRIVE] Recovered video reference for ${siteId}`);
    }
  }

  if (!hasValue(state.transcriptionReference)) {
    const existingTranscript = await findDriveFileByName(
      drive,
      transcriptDriveName(siteId, rawTitle)
    );
    if (existingTranscript?.id) {
      state.transcriptionReference =
        existingTranscript.webViewLink ||
        `https://drive.google.com/file/d/${existingTranscript.id}/view`;
      recoveredDriveState = true;
      console.log(`[DRIVE] Recovered transcript reference for ${siteId}`);
    }
  }

  if (recoveredDriveState) {
    await saveVideoProgress(siteId, rawTitle, state, record);
  }

  const hasUpload = hasValue(state.driveFileId);
  const hasTranscript = hasValue(state.transcriptionReference);

  if (hasUpload && hasTranscript) {
    console.log(`[VIDEO] [SKIP] ${siteId} already has video and transcript`);
    return;
  }

  if (!fileExistsAndNotEmpty(state.savePath)) {
    await resolveAndDownloadVideo(page, siteId, rawTitle, state);
  } else {
    console.log(`[DOWNLOAD] Existing local video: ${state.savePath}`);
  }

  if (!hasValue(state.driveFileId) && fileExistsAndNotEmpty(state.savePath)) {
    const uploadedVideo = await withRetry(
      () =>
        uploadFileToDrive(
          drive,
          state.savePath,
          state.saveName || path.basename(state.savePath),
          "video/mp4"
        ),
      3,
      10000
    );
    state.driveFileId = uploadedVideo.id;
    writeProgressManifest(state);
    await saveVideoProgress(siteId, rawTitle, state, record);
  }

  if (!hasTranscript && !fileExistsAndNotEmpty(state.processedAudio)) {
    await processAudioFromVideo(state);
  }

  await ensureTranscript(drive, state, record);
  writeProgressManifest(state);
  await saveVideoProgress(siteId, rawTitle, state, record);
  console.log(`[VIDEO] Finished ${siteId}`);
}

// ------------------------------ MAIN ------------------------------

async function scrapeData(limit = MAX_VIDEOS) {
  console.log(`[START] One-shot run; checking latest ${limit} videos`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir: USER_DATA_DIR,
    defaultViewport: { width: 1440, height: 1000 },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  let hadItemFailures = false;
  try {
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

    let videoconferencias = await page.evaluate(
      () => window.__NUXT__.data[0].videoconferencias
    );
    videoconferencias = videoconferencias.reverse().slice(0, limit);
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

  if (hadItemFailures) {
    throw new Error("One or more videos failed; the next run will retry them");
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
