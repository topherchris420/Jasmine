"""Dependency-free synchronous Jasmine client (Python 3.10+)."""
import json
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


class JasmineError(RuntimeError):
    """A failed request. `body` is the parsed JSON error, or the raw text when the response was not JSON."""

    def __init__(self, message, status, body=None, code=None):
        super().__init__(message)
        self.status = status
        self.body = body
        if code is None and isinstance(body, dict):
            errors = body.get("errors")
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                code = (errors[0].get("extensions") or {}).get("code")
        self.code = code


def _messages(data):
    errors = data.get("errors") if isinstance(data, dict) else None
    if not isinstance(errors, list):
        return ""
    return "; ".join(str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors)


def _decode(raw, status, ok):
    """Parse a response body; a non-JSON body (proxy error page, HTML 404...) becomes a JasmineError."""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw or "")
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except ValueError:
        prefix = "Invalid JSON response" if ok else "HTTP %d" % status
        raise JasmineError("%s: %s" % (prefix, text.strip()[:200]), status, text, None if not ok else "INVALID_RESPONSE") from None


class JasmineClient:
    def __init__(self, endpoint="http://127.0.0.1:8787", api_key=None, project_id=None, timeout=120):
        self.endpoint = endpoint.rstrip("/")
        self.timeout = timeout
        self.headers = {"Content-Type": "application/json"}
        if api_key:
            self.headers["Authorization"] = "Bearer " + api_key
        if project_id:
            self.headers["x-project-id"] = project_id

    def request(self, path, method="GET", body=None, headers=None, timeout=None):
        req = Request(self.endpoint + path, data=None if body is None else json.dumps(body).encode(), headers={**self.headers, **(headers or {})}, method=method)
        try:
            with urlopen(req, timeout=self.timeout if timeout is None else timeout) as response:
                status = response.status
                raw = response.read()
        except HTTPError as error:
            data = _decode(error.read(), error.code, False)
            raise JasmineError(_messages(data) or "HTTP %d" % error.code, error.code, data) from error
        result = _decode(raw, status, True)
        if isinstance(result, dict) and result.get("errors"):
            raise JasmineError(_messages(result), status, result)
        return result

    def execute_flow(self, flow_id, payload=None, mode="realtime", idempotency_key=None, version=None, bypass_cache=False, timeout=None):
        body = {"payload": {} if payload is None else payload, "mode": mode}
        if version:
            body["version"] = version
        headers = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if bypass_cache:
            headers["X-Bypass-Cache"] = "true"
        return self.request("/api/v1/flows/" + quote(flow_id, safe="") + "/execute", "POST", body, headers, timeout)

    def check_status(self, request_id, timeout=None):
        return self.request("/api/v1/runs/" + quote(request_id, safe=""), timeout=timeout)

    def wait(self, request_id, interval=0.25, timeout=120):
        if interval <= 0 or timeout <= 0:
            raise ValueError("Polling interval and timeout must be positive")
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Run did not finish before the deadline")
            result = self.check_status(request_id, timeout=remaining)
            if result["status"] != "in-progress":
                return result
            time.sleep(min(interval, max(0, deadline - time.monotonic())))

    def cancel(self, request_id):
        return self.request("/api/v1/runs/" + quote(request_id, safe="") + "/cancel", "POST", {})

    def retry(self, request_id):
        return self.request("/api/v1/runs/" + quote(request_id, safe="") + "/retry", "POST", {})

    def trace(self, request_id):
        return self.request("/api/v1/runs/" + quote(request_id, safe="") + "/trace")
