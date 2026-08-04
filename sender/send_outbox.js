"use strict";

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.FLOR_WORK_LEDGER_SPREADSHEET_ID || "1_pQk5GbdUXBs64xsCLg8s0L6zRORZqi5NpTZV4z1IdA";
const OUTBOX_SHEET = process.env.FLOR_OUTBOX_SHEET || "Outbox";
const LEDGER_SHEET = process.env.FLOR_LEDGER_SHEET || "Ledger";
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const IMPERSONATED_USER = process.env.GOOGLE_IMPERSONATED_USER || "";
const SIGNATURE_URL = process.env.FLOR_EMAIL_SIGNATURE_URL || "https://expediente.casitaapps.com/signatures/desarrollo_tecnologico_casitaiedis_edu_mx.jpg?v=1784669030140";
const MAX_ATTEMPTS = Number.parseInt(process.env.FLOR_OUTBOX_MAX_ATTEMPTS || "5", 10);
const STALE_SENDING_MINUTES = Number.parseInt(process.env.FLOR_OUTBOX_STALE_MINUTES || "30", 10);
const TARGET_OUTBOX_ID = String(process.env.FLOR_OUTBOX_ID || "").trim();

function required(value, name) {
  if (!String(value || "").trim()) throw new Error(`Missing required environment variable: ${name}`);
  return String(value).trim();
}

function parseCredentials() {
  let credentials;
  try {
    credentials = JSON.parse(required(SERVICE_ACCOUNT_JSON, "GOOGLE_SERVICE_ACCOUNT_JSON"));
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is invalid: ${error.message}`);
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google service account JSON must include client_email and private_key");
  }
  credentials.private_key = String(credentials.private_key).replace(/\\n/g, "\n");
  return credentials;
}

async function authorize() {
  const credentials = parseCredentials();
  const subject = required(IMPERSONATED_USER, "GOOGLE_IMPERSONATED_USER");
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    subject
  );
  await auth.authorize();
  return auth;
}

function quoteSheetName(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function headerEncode(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), "utf8").toString("base64")}?=`;
}

function wrapBase64(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parsePoints(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
  } catch (_) {
    // Fall through to newline parsing.
  }
  return text
    .split(/\r?\n/)
    .map((item) => item.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function buildHtml(row) {
  const points = parsePoints(row.keyPoints);
  const pointRows = points
    .map(
      (point) => `
        <tr>
          <td style="width:18px;vertical-align:top;padding:0 0 12px 0;color:#1f766f;font-size:18px;line-height:22px;">•</td>
          <td style="padding:0 0 12px 8px;color:#273545;font-size:15px;line-height:22px;">${htmlEscape(point)}</td>
        </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f5f7;font-family:Arial,Helvetica,sans-serif;color:#273545;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f5f7;">
    <tr><td align="center" style="padding:34px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:660px;background:#ffffff;border:1px solid #e1e6ea;border-radius:12px;overflow:hidden;">
        <tr><td style="height:6px;background:#1f766f;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:34px 38px 18px 38px;">
            <h1 style="margin:0;color:#17324d;font-size:27px;line-height:35px;font-weight:700;">${htmlEscape(row.title)}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:0 38px 8px 38px;">
            <h2 style="margin:0 0 12px 0;color:#17324d;font-size:16px;line-height:22px;font-weight:700;">Resumen ejecutivo</h2>
            <p style="margin:0;color:#3c4856;font-size:15px;line-height:24px;">${htmlEscape(row.executiveSummary)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 38px 4px 38px;">
            <h2 style="margin:0 0 16px 0;color:#17324d;font-size:16px;line-height:22px;font-weight:700;">Puntos clave</h2>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${pointRows}</table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 38px 34px 38px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr><td bgcolor="#1f766f" style="border-radius:7px;">
                <a href="${htmlEscape(row.videoUrl)}" target="_blank" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-size:15px;line-height:20px;font-weight:700;border-radius:7px;">Ver conferencia en Google Drive</a>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr><td style="padding:0 38px;"><div style="height:1px;background:#e5eaee;font-size:0;line-height:0;">&nbsp;</div></td></tr>
        <tr>
          <td style="padding:26px 38px 34px 38px;">
            <img src="cid:flor-signature" alt="Firma de Agustín Alejandro Jurado Jaramillo" style="display:block;width:100%;max-width:520px;height:auto;border:0;" width="520">
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildMime(row, signatureBytes, messageId) {
  const boundary = `flor_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const html = buildHtml(row);
  const lines = [
    `From: ${IMPERSONATED_USER}`,
    `To: ${row.to}`,
    row.cc ? `Cc: ${row.cc}` : null,
    `Subject: ${headerEncode(row.subject)}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(html, "utf8")),
    `--${boundary}`,
    "Content-Type: image/jpeg; name=signature.jpg",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <flor-signature>",
    'Content-Disposition: inline; filename="signature.jpg"',
    "",
    wrapBase64(signatureBytes),
    `--${boundary}--`,
    "",
  ].filter((line) => line !== null);
  return lines.join("\r\n");
}

async function downloadSignature() {
  const response = await fetch(SIGNATURE_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`Signature download failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("image")) {
    throw new Error(`Signature URL did not return an image (${contentType || "unknown content type"})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function value(row, index) {
  return String(row[index] ?? "").trim();
}

function mapRow(values, rowNumber) {
  return {
    rowNumber,
    outboxId: value(values, 0),
    conferenceId: value(values, 1),
    title: value(values, 2),
    videoUrl: value(values, 3),
    to: value(values, 4),
    cc: value(values, 5),
    subject: value(values, 6),
    executiveSummary: value(values, 7),
    keyPoints: value(values, 8),
    status: value(values, 9).toLowerCase(),
    createdAt: value(values, 10),
    claimedAt: value(values, 11),
    sentAt: value(values, 12),
    gmailMessageId: value(values, 13),
    attempts: Number.parseInt(value(values, 14) || "0", 10) || 0,
    lastError: value(values, 15),
  };
}

function validateRow(row) {
  const missing = [];
  for (const [key, label] of [
    ["outboxId", "outbox_id"],
    ["conferenceId", "conference_id"],
    ["title", "title"],
    ["videoUrl", "video_url"],
    ["to", "to"],
    ["subject", "subject"],
    ["executiveSummary", "executive_summary"],
    ["keyPoints", "key_points_json"],
  ]) {
    if (!row[key]) missing.push(label);
  }
  if (missing.length) throw new Error(`Outbox row ${row.rowNumber} is missing: ${missing.join(", ")}`);
}

function isStaleSending(row) {
  if (row.status !== "sending" || !row.claimedAt) return false;
  const claimed = Date.parse(row.claimedAt);
  if (!Number.isFinite(claimed)) return true;
  return Date.now() - claimed >= STALE_SENDING_MINUTES * 60_000;
}

function isEligible(row) {
  if (row.status === "pending" || row.status === "failed") return row.attempts < MAX_ATTEMPTS;
  return isStaleSending(row) && row.attempts < MAX_ATTEMPTS;
}

async function updateRow(sheets, rowNumber, updates) {
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(OUTBOX_SHEET)}!A${rowNumber}:P${rowNumber}`,
  });
  const values = Array.from({ length: 16 }, (_, index) => current.data.values?.[0]?.[index] ?? "");
  const indexByKey = {
    status: 9,
    claimedAt: 11,
    sentAt: 12,
    gmailMessageId: 13,
    attempts: 14,
    lastError: 15,
  };
  for (const [key, nextValue] of Object.entries(updates)) {
    values[indexByKey[key]] = nextValue;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(OUTBOX_SHEET)}!A${rowNumber}:P${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}


async function upsertLedgerSent(sheets, row, gmailMessageId, sentAt) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(LEDGER_SHEET)}!A2:K1000`,
  });
  const rows = response.data.values || [];
  const index = rows.findIndex((values) => String(values?.[0] ?? "").trim() === row.conferenceId);
  const now = new Date().toISOString();
  const values = index >= 0 ? Array.from({ length: 11 }, (_, col) => rows[index]?.[col] ?? "") : Array(11).fill("");
  values[0] = row.conferenceId;
  values[1] = row.title;
  values[2] = "TRUE";
  values[3] = "TRUE";
  values[4] = values[4] || row.createdAt || sentAt;
  values[5] = "sent";
  values[6] = gmailMessageId;
  values[7] = sentAt;
  values[8] = now;
  values[9] = "summary_emailed";
  values[10] = "";

  if (index >= 0) {
    const sheetRow = index + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${quoteSheetName(LEDGER_SHEET)}!A${sheetRow}:K${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${quoteSheetName(LEDGER_SHEET)}!A:K`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] },
    });
  }
}

async function markLedgerFailure(sheets, row, errorMessage) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(LEDGER_SHEET)}!A2:K1000`,
  });
  const rows = response.data.values || [];
  const index = rows.findIndex((values) => String(values?.[0] ?? "").trim() === row.conferenceId);
  if (index < 0) return;
  const values = Array.from({ length: 11 }, (_, col) => rows[index]?.[col] ?? "");
  values[5] = "failed";
  values[8] = new Date().toISOString();
  values[9] = "summary_email_failed";
  values[10] = errorMessage;
  const sheetRow = index + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(LEDGER_SHEET)}!A${sheetRow}:K${sheetRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

async function findSentByMessageId(gmail, messageId) {
  const response = await gmail.users.messages.list({
    userId: "me",
    q: `in:sent rfc822msgid:${messageId}`,
    maxResults: 1,
  });
  return response.data.messages?.[0]?.id || "";
}

async function getLedgerDelivery(sheets, conferenceId) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(LEDGER_SHEET)}!A2:K1000`,
  });
  const rows = response.data.values || [];
  const values = rows.find((candidate) => String(candidate?.[0] ?? "").trim() === String(conferenceId));
  if (!values) return null;
  return {
    status: String(values?.[5] ?? "").trim().toLowerCase(),
    gmailMessageId: String(values?.[6] ?? "").trim(),
    sentAt: String(values?.[7] ?? "").trim(),
  };
}

async function processRow({ sheets, gmail, row, signatureBytes }) {
  validateRow(row);
  const deterministicMessageId = `flor-conference-${row.conferenceId}@casitaiedis.edu.mx`
    .replace(/[^a-zA-Z0-9@._-]/g, "-")
    .toLowerCase();

  const existingMessageId = await findSentByMessageId(gmail, deterministicMessageId);
  if (existingMessageId) {
    const now = new Date().toISOString();
    const reconciledSentAt = row.sentAt || now;
    await updateRow(sheets, row.rowNumber, {
      status: "sent",
      sentAt: reconciledSentAt,
      gmailMessageId: existingMessageId,
      lastError: "",
    });
    await upsertLedgerSent(sheets, row, existingMessageId, reconciledSentAt);
    console.log(`[OUTBOX] Reconciled Gmail delivery for conference ${row.conferenceId}`);
    return;
  }

  const ledgerDelivery = await getLedgerDelivery(sheets, row.conferenceId);
  if (ledgerDelivery && (ledgerDelivery.status === "sent" || ledgerDelivery.gmailMessageId)) {
    const reconciledSentAt = ledgerDelivery.sentAt || new Date().toISOString();
    await updateRow(sheets, row.rowNumber, {
      status: "sent",
      sentAt: reconciledSentAt,
      gmailMessageId: ledgerDelivery.gmailMessageId,
      lastError: "",
    });
    console.log(`[OUTBOX] Skipped conference ${row.conferenceId}; Ledger already records delivery`);
    return;
  }

  const claimedAt = new Date().toISOString();
  const attempts = row.attempts + 1;
  await updateRow(sheets, row.rowNumber, {
    status: "sending",
    claimedAt,
    attempts,
    lastError: "",
  });

  try {
    const mime = buildMime(row, signatureBytes, deterministicMessageId);
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: toBase64Url(mime) },
    });
    const gmailMessageId = sent.data.id || "";
    if (!gmailMessageId) throw new Error("Gmail API returned no message ID");

    const verified = await gmail.users.messages.get({
      userId: "me",
      id: gmailMessageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "Subject"],
    });
    if (!verified.data.id) throw new Error("Sent message could not be verified");

    const sentAt = new Date().toISOString();
    await updateRow(sheets, row.rowNumber, {
      status: "sent",
      sentAt,
      gmailMessageId,
      lastError: "",
    });
    await upsertLedgerSent(sheets, row, gmailMessageId, sentAt);
    console.log(`[OUTBOX] Sent ${row.outboxId}; gmail_message_id=${gmailMessageId}`);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await updateRow(sheets, row.rowNumber, {
      status: "failed",
      lastError: message,
    });
    await markLedgerFailure(sheets, row, message).catch((ledgerError) => {
      console.error(`[LEDGER][ERROR] ${ledgerError?.message || ledgerError}`);
    });
    throw error;
  }
}

async function main() {
  const auth = await authorize();
  const sheets = google.sheets({ version: "v4", auth });
  const gmail = google.gmail({ version: "v1", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetName(OUTBOX_SHEET)}!A2:P500`,
  });
  const rows = (response.data.values || []).map((values, index) => mapRow(values, index + 2));
  let pending = rows.filter(isEligible);
  if (TARGET_OUTBOX_ID) {
    pending = pending.filter((row) => row.outboxId === TARGET_OUTBOX_ID);
    if (!pending.length) {
      throw new Error(`No eligible Outbox row found for FLOR_OUTBOX_ID=${TARGET_OUTBOX_ID}`);
    }
  }
  if (!pending.length) {
    console.log("[OUTBOX] No pending email");
    return;
  }

  console.log(`[OUTBOX] ${pending.length} pending email(s)${TARGET_OUTBOX_ID ? ` for ${TARGET_OUTBOX_ID}` : ""}`);
  const signatureBytes = await downloadSignature();
  let failures = 0;
  for (const row of pending) {
    try {
      await processRow({ sheets, gmail, row, signatureBytes });
    } catch (error) {
      failures += 1;
      console.error(`[OUTBOX][ERROR] row=${row.rowNumber} id=${row.outboxId}: ${error?.message || error}`);
    }
  }
  if (failures) throw new Error(`${failures} outbox email(s) failed`);
}

main().catch((error) => {
  console.error(`[RUN][ERROR] ${error?.stack || error}`);
  process.exitCode = 1;
});
