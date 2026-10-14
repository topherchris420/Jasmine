# Connected services

Jasmine runs inference through its local model connections. App nodes can separately read and write external services using credentials you explicitly configure under **Integrations**. Credentials are encrypted on disk; the browser receives field names, never stored values.

## Google Drive and Google Sheets

Supply an OAuth **access token** with the scopes required for your actions. To renew expired tokens automatically, also supply the OAuth **client id**, **refresh token**, and **client secret** when required by your OAuth client. Obtain these through your own registered application and consent process. Jasmine does not bundle a shared OAuth app or an interactive consent flow.

An expired API token receives one refresh attempt after HTTP 401. Rotated access and refresh tokens are stored encrypted. HTTP 403 is a permissions error and does not trigger refresh.

| Node | Actions | Important fields |
|---|---|---|
| Google Drive | List files, metadata, download/extract, native document export, text upload, create folder, delete file | `fileId`, `folderId`, `query`, `pageToken`, `name`, `content`, `mimeType` |
| Google Sheets | Read, append, update, clear cell values | `spreadsheetId`, `range` (A1 notation), `values`, `valueInputOption` |

Drive list results include `nextPageToken`; pass it as `pageToken` for the next page. Native Workspace documents use the export API. Downloads return extracted `content`, `pages`, and file metadata, ready to feed into Chunking or Index nodes. This is document extraction, not a binary file-transfer client. Unsupported file formats may require conversion first.

Sheets `values` is an array of rows, for example `[["name", "score"], ["Jasmine", 42]]`. `RAW` is the default interpretation; choose `USER_ENTERED` for spreadsheet formula and value interpretation. Write nodes suppress automatic retries after ambiguous failures to avoid duplicate appends or creates.

## OneDrive and SharePoint

Supply a Microsoft Graph access token with suitable file/site permissions. Refresh requires your OAuth client id, refresh token, optional client secret, and tenant id (default `common`). Register and authorize your own application.

Actions: **list**, **drives**, **get**, **download**, **upload** (text), **createFolder**, and **delete**. Select a `driveId` or, for SharePoint, a `siteId`; OneDrive can default to `/me/drive`. `itemId` defaults to `root`.

List responses expose `files` and `nextLink`. Only a Microsoft Graph v1.0 URL is accepted for pagination. Graph content downloads may redirect to a short-lived preauthenticated HTTPS URL; Jasmine fetches that URL without forwarding the OAuth bearer token.

## Other integrations

The node catalog provides configuration fields for HTTP APIs, Slack, Microsoft Teams, Discord, Telegram, SMTP, Notion, Airtable, GitHub, Twilio, n8n, PostgreSQL, S3-compatible storage, MCP, RSS, and SearXNG. SMTP supports Gmail with an app password; it does not implement Gmail inbox operations. PostgreSQL requires a reachable PostgreSQL server. S3 supports compatible local object stores. MCP uses Streamable HTTP.

External-service tests exercise request formats, credential handling, refresh, pagination, downloads, and failures against controlled fixtures. They do not certify live access to every account, tenant, database, or provider version.
