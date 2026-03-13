# Google Apps Script Webhook Guide

This guide shows how to put the Google Apps Script into your Google account and get the webhook URL used by the subscription server.

## What you are doing

You are not adding the script to Vercel or Cloudflare.

You are creating a small Google-hosted script inside your own Google account.

That script will:

- create yearly Google Sheets files
- create monthly tabs
- append raw rows sent by the Worker

## File to copy

Use this file from the repo:

- [`templates/google-apps-script/Code.gs`](C:\workspace\subscription_server\templates\google-apps-script\Code.gs)

## Step 1: Open Google Apps Script

1. Open `https://script.google.com`
2. Sign in with the Google account that should own the Sheets files
3. Click `New project`

## Step 2: Create the script project

1. Rename the project to something like `Subscription Sheets Bridge`
2. In the editor, open the default file named `Code.gs`
3. Delete the default code
4. Copy everything from [`templates/google-apps-script/Code.gs`](C:\workspace\subscription_server\templates\google-apps-script\Code.gs)
5. Paste it into `Code.gs`
6. Click `Save`

## Step 3: Deploy it as a Web App

1. Click `Deploy`
2. Click `New deployment`
3. For deployment type, choose `Web app`
4. Fill the form:
   - Description: `Subscription Sheets Webhook`
   - Execute as: `Me`
   - Who has access: `Anyone`
5. Click `Deploy`

## Step 4: Grant permissions

Google will ask for permission.

Approve access so the script can:

- create spreadsheets in your Google Drive
- open existing spreadsheets
- write rows into Google Sheets

After approval, Google will show a Web App URL.

It will look similar to:

```text
https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXX/exec
```

That URL is the webhook URL.

## Step 5: Put the webhook URL into admin UI

Open your admin page and go to the Pricing section.

Fill these fields:

- `Backup enabled`: `enabled`
- `Apps Script webhook URL`: paste the `/exec` URL
- `Sheet owner email`: your Google email
- `Spreadsheet prefix`: for example `Subscription`

Then click `Save Pricing`.

## Step 6: Test it

1. Make sure there is at least one queued backup row
2. In admin UI, click `Backup Now`
3. Check your Google Drive

Expected result:

- a spreadsheet like `Subscription 2026`
- a monthly tab like `03`

For bulk gift card rows, the script will create a separate file like:

- `Subscription Gift Card Issuance 2026`

## If you update the script later

If you change the code in `Code.gs` later:

1. Save the script
2. Click `Deploy`
3. Click `Manage deployments`
4. Edit the existing Web App deployment
5. Deploy the new version

Usually the webhook URL stays the same for the same deployment.

## Related files

- [`templates/google-apps-script/Code.gs`](C:\workspace\subscription_server\templates\google-apps-script\Code.gs)
- [`docs/google-apps-script-setup.md`](C:\workspace\subscription_server\docs\google-apps-script-setup.md)
- [`backend/worker.mjs`](C:\workspace\subscription_server\backend\worker.mjs)
