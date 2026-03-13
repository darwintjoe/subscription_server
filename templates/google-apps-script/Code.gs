const REGULAR_HEADERS = [
  "received_at",
  "event_type",
  "code_source",
  "code_value",
  "duration_code",
  "status",
  "external_payment_id",
  "country",
  "currency",
  "amount",
  "actor_email",
  "customer_ref",
  "generated_at",
  "redeemed_at",
  "note",
  "raw_json",
];

const BULK_HEADERS = [
  "received_at",
  "batch_id",
  "batch_note",
  "duration_code",
  "quantity",
  "code_value",
  "issued_by_email",
  "generated_at",
  "raw_json",
];

function doPost(e) {
  try {
    const body = parseBody_(e);
    const mode = body.mode === "bulk_gift_card" ? "bulk_gift_card" : "regular";
    const spreadsheetTitle = String(body.spreadsheet_title || "").trim();
    const sheetTitle = String(body.sheet_title || "").trim();

    if (!spreadsheetTitle) {
      return jsonResponse_(400, { ok: false, error: "spreadsheet_title_required" });
    }

    if (!sheetTitle) {
      return jsonResponse_(400, { ok: false, error: "sheet_title_required" });
    }

    const rows = normalizeRows_(body);
    if (!rows.length) {
      return jsonResponse_(400, { ok: false, error: "rows_required" });
    }

    const spreadsheet = getOrCreateSpreadsheet_(spreadsheetTitle);
    const sheet = getOrCreateSheet_(spreadsheet, sheetTitle);
    const headers = mode === "bulk_gift_card" ? BULK_HEADERS : REGULAR_HEADERS;
    ensureHeaders_(sheet, headers);

    const values = rows.map((row) => {
      return mode === "bulk_gift_card"
        ? mapBulkRow_(row, body)
        : mapRegularRow_(row, body);
    });

    const startRow = Math.max(sheet.getLastRow(), 1) + 1;
    sheet.getRange(startRow, 1, values.length, headers.length).setValues(values);

    return jsonResponse_(200, {
      ok: true,
      mode,
      spreadsheet_title: spreadsheetTitle,
      sheet_title: sheetTitle,
      rows_appended: values.length,
      spreadsheet_url: spreadsheet.getUrl(),
    });
  } catch (error) {
    return jsonResponse_(500, { ok: false, error: error.message });
  }
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("missing_request_body");
  }
  return JSON.parse(e.postData.contents);
}

function normalizeRows_(body) {
  if (Array.isArray(body.rows) && body.rows.length) {
    return body.rows;
  }
  if (body.record && typeof body.record === "object") {
    return [body.record];
  }
  return [];
}

function getOrCreateSpreadsheet_(title) {
  const files = DriveApp.getFilesByName(title);
  if (files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }
  return SpreadsheetApp.create(title);
}

function getOrCreateSheet_(spreadsheet, sheetTitle) {
  let sheet = spreadsheet.getSheetByName(sheetTitle);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetTitle);
  }
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() > 0) {
    return;
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function mapRegularRow_(row, body) {
  return [
    isoNow_(),
    body.event_type || row.event_type || "",
    row.code_source || row.source || row.flow_type || "",
    row.code_value || "",
    row.duration_code || "",
    row.status || "",
    row.external_payment_id || row.payment_ref || "",
    row.country || "",
    row.currency || "",
    row.amount != null ? row.amount : "",
    row.actor_email || row.reseller_email || row.admin_email || "",
    row.customer_ref || row.customer_email || "",
    row.generated_at || row.issued_at || "",
    row.redeemed_at || "",
    row.note || "",
    JSON.stringify(row),
  ];
}

function mapBulkRow_(row, body) {
  return [
    isoNow_(),
    row.batch_id || body.batch_id || "",
    row.batch_note || row.note || "",
    row.duration_code || "",
    row.quantity != null ? row.quantity : "",
    row.code_value || "",
    row.issued_by_email || row.actor_email || "",
    row.generated_at || row.issued_at || "",
    JSON.stringify(row),
  ];
}

function isoNow_() {
  return new Date().toISOString();
}

function jsonResponse_(status, payload) {
  const output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
