"""Dependency-free synchronous Jasmine client (Python 3.10+)."""
import json
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


class JasmineError(RuntimeError):
    def __init__(self, message, status, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


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
                result = json.load(response)
        except HTTPError as error:
            data = json.loads(error.read())
            raise JasmineError("; ".join(e["message"] for e in data.get("errors", [])), error.code, data) from error
        if isinstance(result, dict) and result.get("errors"):
            raise JasmineError("; ".join(e["message"] for e in result["errors"]), 200, result)
        return result

    def execute_flow(self, flow_id, payload=None, mode="realtime", idempotency_key=None, version=None):
        body = {"payload": {} if payload is None else payload, "mode": mode}
        if version:
            body["version"] = version
        return self.request("/api/v1/flows/" + quote(flow_id, safe="") + "/execute", "POST", body, {"Idempotency-Key": idempotency_key} if idempotency_key else None)

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
