# Connected services

Configure service credentials under **Integrations**. Credentials are encrypted on disk; Studio receives field names rather than stored values. External service nodes make requests only when configured and executed. Local model inference is configured separately under **Models**.

Addresses you enter in a credential (a SearXNG, n8n or GitHub Enterprise URL, a webhook URL, an S3 endpoint, an MCP server) are trusted configuration and may be local or private. URLs that flow data supplies are checked by the [egress policy](OPERATIONS.md#outbound-requests-from-flows) instead.

## Google and Microsoft account connections

Choose **Connect account** on Google Drive, Sheets, Gmail, OneDrive or SharePoint. Register your own OAuth application first, with a callback of `http://127.0.0.1:8787/oauth/callback/google` or `/oauth/callback/microsoft` (use your actual Jasmine origin). Provide its client id and secret when required. Microsoft connections also accept a tenant id.

Jasmine opens account authorization using PKCE and a one-use, ten-minute state. Read-only access is the default. Disable it when you need writes. The callback stores account tokens encrypted. This connects a service account; it does not create a Jasmine sign-in account. No shared OAuth client is bundled.

You can also enter tokens directly. Automatic renewal needs an access token, refresh token, client id and optional client secret/tenant id. A 401 receives one refresh attempt; rotated tokens persist. A 403 is treated as a permission error.

| Node | Actions | Main fields |
|---|---|---|
| Google Drive | List, metadata, download/extract, native document export, text upload, folder creation, delete | `fileId`, `folderId`, `query`, `pageToken`, `name`, `content`, `mimeType` |
| Google Sheets | Read, append, update, clear values | `spreadsheetId`, A1 `range`, row-array `values`, `valueInputOption` |
| Gmail | Messages/threads/labels, message/thread details, thread label changes, send, draft, reply | Action, query, ids, recipient, subject, body, attachments |
| OneDrive/SharePoint | Files, drives, metadata, download/extract, text upload, folder creation, delete | `driveId`, `siteId`, `itemId`, `nextLink`, `name`, `content` |
| Webflow | Sites, collections, collection items, pages, page DOM | Token, `siteId`, `collectionId`, `pageId`, offset/limit |

Drive exposes `nextPageToken`; pass it as `pageToken`. Native documents use the export API. File downloads return extracted text/pages and metadata. Graph pagination accepts only a Graph v1.0 URL; preauthenticated file redirects are fetched without forwarding the bearer token. Sheets defaults to `RAW`; select `USER_ENTERED` to interpret formulas. Gmail uses its mailbox API; SMTP is a separate node.

Writes require suitable scopes and are marked as side effects. Automatic retries are suppressed after ambiguous non-idempotent failures. The catalog is authoritative for supported fields and actions; the presence of a service does not imply its entire API is wrapped.

## Databases and storage

| Adapter | Configuration | Behavior |
|---|---|---|
| PostgreSQL | Connection URI | Parameterized query; template values bind as `$n` parameters |
| MySQL | URI or host/port/user/password/database, optional TLS | Prepared statements with ordered `?` bindings, including template values |
| SQL Server | Connection string or server/port/user/password/database, TLS settings | Named parameters; connection cleanup and cancellation |
| Local Tables | No account | Persistent SQLite tables with validated columns and row operations |
| S3-compatible | Endpoint, region, access id/secret, path-style setting | Upload/download/list/delete, signed GET, server-side copy and move |

Database adapters need reachable database servers; Jasmine does not host those servers. SQL templates insert bound values, not identifiers. Use fixed table/column names. S3 listing exposes continuation tokens and can fetch 1–100 bounded pages per action. Copy uses the server-side copy API; move deletes only after a valid complete copy result. Temporary session-token credentials are signed for requests and shared links. Multipart copies, automatic session renewal and every provider extension are not implemented.

## Scheduled sources and mail

The **Scheduled Source** trigger polls a configured app/database read action, selects a returned record list, and emits `records`, `source` and `scheduledAt`. Writes are rejected before the adapter runs. It reads each scheduled result rather than subscribing to every provider's native change feed.

**Inbound Email** is a real local SMTP trigger. Configure `MAIL_PORT` to start the listener; **Deployments** shows the stable recipient for each active mail flow. The runtime parses subject, sender, recipients, text, HTML and attachments. Internet mail delivery needs your own mail routing. See [operations](OPERATIONS.md).

## Other services

The catalog includes Slack, Teams, Discord, Telegram, SMTP, Notion, Airtable, GitHub, Twilio, n8n, SearXNG, RSS, HTTP, scraping/crawling and outbound MCP tools. Providers with webhook support can send JSON to a deployed signed webhook trigger. The inbound `/mcp` endpoint separately exposes Jasmine's own flow and management tools.

Tests use controlled HTTP fixtures and database-driver mocks, plus a real loopback SMTP listener. They verify contracts, token handling, pagination and error behavior. They do not certify every live account, tenant, server version or external service action.
