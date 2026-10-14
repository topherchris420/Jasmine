# Jasmine application clients

JavaScript and Python clients use only their standard runtimes. The Go module uses only the Go standard library. Copy or vendor the SDK directory into your application; the repository package is private and is not published to a package registry.

## JavaScript and Python

```javascript
import { JasmineClient } from './jasmine.mjs';
const client = new JasmineClient({endpoint: 'http://127.0.0.1:8787', apiKey: process.env.JASMINE_API_KEY});
const accepted = await client.executeFlow('flow-id', {message: 'Hello'}, {mode: 'async', idempotencyKey: 'request-001', bypassCache: true});
console.log(await client.wait(accepted.requestId));
```

JS methods: `executeFlow`, `checkStatus`, `wait`, `cancel`, `retry`, `trace` and async `events`. `version` pins a deployment; abort signals cancel client requests. Python provides the same core operations with snake_case names and bounded synchronous polling; `bypass_cache=True` bypasses the response cache. Python does not currently implement SSE.

Timeouts: each JS request is bounded by `timeoutMs` (constructor option, default 60 s; pass `timeoutMs` per call to override, `0` disables it). A realtime `executeFlow` waits for the whole run, so it uses `executeTimeoutMs` instead (default 150 s, above the server's 2-minute realtime budget). `wait()` keeps its own overall `timeoutMs` (default 120 s) and `events()` streams without a timeout. A client timeout rejects with `JasmineError` code `TIMEOUT`. Python uses `timeout=` (seconds, default 120) on the client, `execute_flow` and `check_status`.

Errors: both clients raise `JasmineError` with `status`, `body` and `code`. When a response is not JSON (a reverse-proxy error page, for example), `body` holds the raw text and the message starts with `HTTP <status>`. A run that executed but failed is not an exception: check `status` and read `error` (`code`, `message`, `nodeId`, `retryable`).

## React and Next.js

Supply React 18 or 19 from your own app. Copy `react.mjs` and `jasmine.mjs` together. In Next.js, use the hook/component in a client component:

```jsx
'use client';
import { JasmineChat } from './jasmine-sdk/react.mjs';
export default function Chat() {
  return <JasmineChat endpoint="http://127.0.0.1:8787" flowId="deployed-chat-id" />;
}
```

`JasmineChat` uses a deployed public Chat Widget trigger and preserves the conversation session. Style its section, paragraphs, input and button in your app. It accepts `className` and `onError`.

`useJasmineFlow({endpoint, flowId, apiKey, projectId})` exposes `execute(payload, options)`, `cancel()`, `status`, `requestId`, `output`, `error` and streamed `tokens`. It accepts one active run at a time. Use protected execute keys in a server route when they should not be exposed to browser users; public widgets do not require an execution key.

## Go

In your application's `go.mod`, vendor the SDK or add:

```go
require jasmine.local/sdk v0.0.0
replace jasmine.local/sdk => ./jasmine-sdk/go
```

```go
client := jasmine.Client{Endpoint: "http://127.0.0.1:8787", APIKey: os.Getenv("JASMINE_API_KEY")}
ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
defer cancel()
run, err := client.Execute(ctx, "flow-id", map[string]any{"message": "Hello"}, jasmine.ExecuteOptions{Mode: "async"})
if err != nil { log.Fatal(err) }
finished, err := client.Wait(ctx, run.RequestID, 250*time.Millisecond)
```

Import `jasmine "jasmine.local/sdk"` and the standard packages used above. Core methods are `Execute`, `Status`, `Wait`, `Cancel` and `Retry`. Options include mode, version, idempotency key and cache bypass. All calls accept a context. A failed run has `Status` `"failed"` or `"error"`, and `run.Error` (`Code`, `Message`, `NodeID`, `Retryable`) and `run.Message` say why. The default HTTP client times out after 120 s; set `Client.HTTP` to change it. Run `go test ./...` in `sdk/go` to test the module. Go SSE support is not included.

## Management CLI

```bash
npm run cli -- help
npm run cli -- configure --endpoint http://127.0.0.1:8787
npm run cli -- flows list
npm run cli -- flows get flow-id
npm run cli -- flows run flow-id --file payload.json --async
npm run cli -- flows rename flow-id --name 'New name'
npm run cli -- deployments rollback flow-id --version version-id
npm run cli -- logs get request-id
npm run cli -- project export --output project.json
npm run cli -- project import project.json
```

`--json` supplies an inline JSON body; `--file` reads it from disk. `JASMINE_ENDPOINT`, `JASMINE_API_KEY` and `JASMINE_PROJECT_ID` override the saved local profile. `configure` saves the endpoint and environment-supplied key/project id. The profile uses mode 0600 when created. Set `JASMINE_CLI_CONFIG` to change its location.

`project export` saves the same JSON as **Settings → Export project**; `project import FILE` (or **Settings → Import project**) adds that file's flows as drafts through `POST /api/import`. Nothing is deployed, and the import stops if a flow id already exists.

For backups, set `JASMINE_BACKUP_PASSPHRASE`, then run `backup export --output backup.json` or `backup restore --file backup.json`. Restores create a separate workspace; start Jasmine with the returned data directory. API keys and passphrases should be supplied through environment variables rather than command arguments.
