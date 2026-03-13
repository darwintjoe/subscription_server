# Google Apps Script Setup

This document shows where to save the Google Apps Script and how to deploy it so the Cloudflare Worker can append raw rows into Google Sheets.

## What this script does

- receives JSON from the Worker
- creates the yearly spreadsheet if it does not exist
- creates the monthly tab if it does not exist
- appends raw rows
- supports:
  - regular transaction rows
  - bulk gift-card rows in a separate spreadsheet file

Template file:

- [`templates/google-apps-script/Code.gs`](C:\workspace\subscription_server\templates\google-apps-script\Code.gs)

## Where to save it

Save it in your own Google account, not in Vercel and not in Cloudflare.

Use this flow:

1. Open `https://script.google.com`
2. Click `New project`
3. Rename the project to something like `Subscription Sheets Bridge`
4. Replace the default `Code.gs` with the contents of [`templates/google-apps-script/Code.gs`](C:\workspace\subscription_server\templates\google-apps-script\Code.gs)
5. Click `Save`

This script lives inside your Google account and will use your Google Drive / Google Sheets permissions.

## How to deploy it

1. In Google Apps Script, click `Deploy`
2. Click `New deployment`
3. Choose type `Web app`
4. Description:
   `Subscription Sheets Webhook`
5. Execute as:
   `Me`
6. Who has access:
   `Anyone`
7. Click `Deploy`
8. Authorize the requested Google permissions
9. Copy the generated Web App URL

The copied URL will look similar to:

```text
https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXX/exec
```

That is the webhook URL.

## Where to put the webhook URL

Put the URL into the admin config as `sheet_script_url`.

Current related config fields:

- `sheet_backup_enabled`
- `sheet_script_url`
- `sheet_owner_email`
- `backup.sheet_prefix`

The Worker will `POST` JSON to that URL.

## File naming

Recommended naming:

- regular transactions:
  - spreadsheet title: `Subscription 2026`
  - sheet title: `03`
- bulk gift-card issuance:
  - spreadsheet title: `Gift Card Issuance 2026`
  - sheet title: `03`

This matches your rule:

- separate file each year
- separate tab each month
- bulk gift-card rows must not mix with daily transaction rows

## Payload shape

The template accepts either a single `record` or a `rows` array.

Regular transaction example:

```json
{
  "mode": "regular",
  "spreadsheet_title": "Subscription 2026",
  "sheet_title": "03",
  "owner_email": "owner@example.com",
  "event_type": "code.issued",
  "record": {
    "code_source": "reseller",
    "code_value": "SM-12M-ABCD-EFGH",
    "duration_code": "12_months",
    "status": "issued",
    "external_payment_id": "pay_001",
    "country": "TH",
    "currency": "THB",
    "amount": 1290,
    "actor_email": "seller@example.com",
    "generated_at": "2026-03-13T02:00:00.000Z",
    "note": "Reseller sale"
  }
}
```

Bulk gift-card example:

```json
{
  "mode": "bulk_gift_card",
  "spreadsheet_title": "Gift Card Issuance 2026",
  "sheet_title": "03",
  "rows": [
    {
      "batch_id": "batch_20260313_001",
      "batch_note": "Ramadan promo",
      "duration_code": "12_months",
      "quantity": 100,
      "code_value": "SM-12M-AAAA-BBBB",
      "issued_by_email": "admin@example.com",
      "generated_at": "2026-03-13T02:00:00.000Z"
    }
  ]
}
```

## How the columns work

The script writes fixed header columns and keeps the full original object in `raw_json`.

This keeps the Worker simple:

- Worker appends raw rows only
- detailed formulas and summaries stay inside Google Sheets

If you later want more columns, edit the header arrays at the top of [`templates/google-apps-script/Code.gs`](C:\workspace\subscription_server\templates\google-apps-script\Code.gs).

## Worker behavior

The Worker now sends batched unsent rows to this script when:

- admin presses `Backup Now`
- the daily scheduled backup runs at `3:00 AM UTC+7`

The Worker sends:

- `mode = regular` for normal transaction rows
- `mode = bulk_gift_card` for gift-card batch rows
- yearly spreadsheet titles using `backup.sheet_prefix`
- monthly tab titles using the configured backup timezone
