"""Python SDK for the AI Workforce public API (/v1).

Standard library only (urllib, hmac, json), Python 3.9+. Mirrors the TypeScript SDK (@workforce/sdk); the routes and shapes
are in the API's OpenAPI document (GET /v1/openapi.json). Objects come back as plain dicts.

    from workforce_sdk import Client
    wf = Client(api_key=os.environ["WORKFORCE_API_KEY"], base_url="https://api.example.com")
    answer = wf.employees.send_message(employee_id, message="Hi", customer="rahul@example.com")
    for event in wf.employees.stream_message(employee_id, message="Hi"):
        if event["type"] == "text":
            print(event["text"], end="")
    for conversation in wf.paginate(wf.conversations.list, employee_id=employee_id):
        print(conversation["title"])
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from typing import Any, Callable, Dict, Iterator, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

__all__ = ["Client", "WorkforceError", "WebhookVerificationError", "verify_webhook"]
__version__ = "0.1.0"


class WorkforceError(Exception):
    """An error answer from the API: `status`, `type` (invalid_request, not_found, ...), `issues`, `request_id`."""

    def __init__(self, status: int, body: Optional[dict], request_id: Optional[str]):
        error = (body or {}).get("error") or {}
        super().__init__(error.get("message") or f"HTTP {status}")
        self.status = status
        self.type = error.get("type") or "server_error"
        self.issues = error.get("issues") or []
        self.request_id = request_id


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def _clean(values: Mapping[str, Any]) -> Dict[str, Any]:
    """Drops None, and names fields the way the API spells them (employee_id -> employeeId)."""
    return {_camel(k): v for k, v in values.items() if v is not None}


class Client:
    def __init__(self, api_key: str, base_url: str = "http://localhost:4000", max_retries: int = 2, timeout: float = 120.0):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self.timeout = timeout
        self.employees = _Employees(self)
        self.conversations = _Conversations(self)
        self.customers = _Customers(self)
        self.knowledge = _Knowledge(self)
        self.workflows = _Workflows(self)
        self.executions = _Executions(self)
        self.tools = _Tools(self)
        self.analytics = _Analytics(self)

    def _open(self, method: str, path: str, query: Optional[Mapping[str, Any]] = None, body: Any = None,
              idempotent: bool = False, idempotency_key: Optional[str] = None, accept: str = "application/json"):
        url = self.base_url + path
        if query:
            url += "?" + urlencode({k: (str(v).lower() if isinstance(v, bool) else v) for k, v in _clean(query).items()})
        # Writes that may be retried get a key, so a retry after a lost answer does not act twice.
        key = idempotency_key or (str(uuid.uuid4()) if idempotent else None)
        retryable = method == "GET" or key is not None
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": accept, "User-Agent": f"workforce-sdk-python/{__version__}"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        if key:
            headers["Idempotency-Key"] = key
        attempt = 0
        while True:
            try:
                return urlopen(Request(url, data=data, headers=headers, method=method), timeout=self.timeout)
            except HTTPError as err:
                if retryable and attempt < self.max_retries and (err.code == 429 or err.code >= 500):
                    after = err.headers.get("Retry-After")
                    time.sleep(min(float(after), 60) if after else 0.5 * 2 ** attempt)
                    attempt += 1
                    continue
                try:
                    payload = json.loads(err.read() or b"null")
                except ValueError:
                    payload = None
                raise WorkforceError(err.code, payload, err.headers.get("request-id")) from None
            except URLError:
                if not retryable or attempt >= self.max_retries:
                    raise
                time.sleep(0.5 * 2 ** attempt)
                attempt += 1

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        with self._open(method, path, **kwargs) as res:
            return json.loads(res.read())

    def _events(self, method: str, path: str, body: Any) -> Iterator[dict]:
        with self._open(method, path, body=body, accept="text/event-stream") as res:
            for raw in res:
                line = raw.decode().rstrip("\r\n")
                if line.startswith("data: "):
                    yield json.loads(line[6:])

    def paginate(self, list_method: Callable[..., dict], **query: Any) -> Iterator[dict]:
        """Every item of a list, page after page: `for c in wf.paginate(wf.conversations.list, employee_id=...)`."""
        cursor = query.pop("cursor", None)
        while True:
            page = list_method(**query, cursor=cursor)
            yield from page["data"]
            cursor = page.get("nextCursor")
            if not cursor:
                return


def _id(value: str) -> str:
    return quote(value, safe="")


class _Namespace:
    def __init__(self, client: Client):
        self._c = client


class _Employees(_Namespace):
    def list(self, limit: Optional[int] = None, cursor: Optional[str] = None, status: Optional[str] = None) -> dict:
        return self._c._request("GET", "/v1/employees", query={"limit": limit, "cursor": cursor, "status": status})

    def get(self, employee_id: str) -> dict:
        return self._c._request("GET", f"/v1/employees/{_id(employee_id)}")

    def create(self, name: str, role: str, idempotency_key: Optional[str] = None, **fields: Any) -> dict:
        """Version 1, not published. Optional: description, personality, instructions, goals, language, time_zone."""
        return self._c._request("POST", "/v1/employees", body=_clean({"name": name, "role": role, **fields}), idempotent=True, idempotency_key=idempotency_key)

    def save_version(self, employee_id: str, idempotency_key: Optional[str] = None, **fields: Any) -> dict:
        """A new version with these fields changed; customers keep the published one until `publish`."""
        return self._c._request("POST", f"/v1/employees/{_id(employee_id)}/versions", body=_clean(fields), idempotent=True, idempotency_key=idempotency_key)

    def publish(self, employee_id: str, version: Optional[int] = None) -> dict:
        return self._c._request("POST", f"/v1/employees/{_id(employee_id)}/publish", body=_clean({"version": version}))

    def send_message(self, employee_id: str, message: str, conversation_id: Optional[str] = None, customer: Optional[str] = None,
                     idempotency_key: Optional[str] = None) -> dict:
        """The published version answers; the reply comes back whole."""
        body = _clean({"message": message, "conversation_id": conversation_id, "customer": customer})
        return self._c._request("POST", f"/v1/employees/{_id(employee_id)}/messages", body=body, idempotent=True, idempotency_key=idempotency_key)

    def stream_message(self, employee_id: str, message: str, conversation_id: Optional[str] = None, customer: Optional[str] = None) -> Iterator[dict]:
        """The reply as it is written: {"type": "text"} pieces, then "done" (or "error"). Not retried."""
        body = _clean({"message": message, "conversation_id": conversation_id, "customer": customer})
        return self._c._events("POST", f"/v1/employees/{_id(employee_id)}/messages/stream", body)


class _Conversations(_Namespace):
    def list(self, limit: Optional[int] = None, cursor: Optional[str] = None, employee_id: Optional[str] = None, customer_id: Optional[str] = None,
             channel: Optional[str] = None, status: Optional[str] = None) -> dict:
        query = {"limit": limit, "cursor": cursor, "employee_id": employee_id, "customer_id": customer_id, "channel": channel, "status": status}
        return self._c._request("GET", "/v1/conversations", query=query)

    def get(self, conversation_id: str) -> dict:
        return self._c._request("GET", f"/v1/conversations/{_id(conversation_id)}")

    def resolve(self, conversation_id: str) -> dict:
        return self._c._request("POST", f"/v1/conversations/{_id(conversation_id)}/resolve", idempotent=True)


class _Customers(_Namespace):
    def list(self, limit: Optional[int] = None, cursor: Optional[str] = None, external_id: Optional[str] = None) -> dict:
        return self._c._request("GET", "/v1/customers", query={"limit": limit, "cursor": cursor, "external_id": external_id})

    def get(self, customer_id: str) -> dict:
        return self._c._request("GET", f"/v1/customers/{_id(customer_id)}")

    def set_memory(self, customer_id: str, key: str, value: str, category: Optional[str] = None) -> dict:
        body = _clean({"value": value, "category": category})
        return self._c._request("PUT", f"/v1/customers/{_id(customer_id)}/memories/{_id(key)}", body=body, idempotent=True)

    def delete_memory(self, customer_id: str, key: str) -> dict:
        return self._c._request("DELETE", f"/v1/customers/{_id(customer_id)}/memories/{_id(key)}", idempotent=True)


class _Knowledge(_Namespace):
    def list_sources(self, limit: Optional[int] = None, cursor: Optional[str] = None) -> dict:
        return self._c._request("GET", "/v1/knowledge/sources", query={"limit": limit, "cursor": cursor})

    def get_source(self, source_id: str) -> dict:
        return self._c._request("GET", f"/v1/knowledge/sources/{_id(source_id)}")

    def create_source(self, name: str, description: str = "") -> dict:
        return self._c._request("POST", "/v1/knowledge/sources", body={"name": name, "description": description}, idempotent=True)

    def upload_document(self, source_id: str, name: str, content: bytes) -> dict:
        """A PDF, DOCX, TXT or CSV file, up to 10 MB; processed in the background."""
        body = {"name": name, "contentBase64": base64.b64encode(content).decode()}
        return self._c._request("POST", f"/v1/knowledge/sources/{_id(source_id)}/documents", body=body, idempotent=True)

    def search(self, query: str, source_ids: Optional[list] = None, limit: Optional[int] = None) -> dict:
        return self._c._request("POST", "/v1/knowledge/search", body=_clean({"query": query, "source_ids": source_ids, "limit": limit}))


class _Workflows(_Namespace):
    def list(self, limit: Optional[int] = None, cursor: Optional[str] = None) -> dict:
        return self._c._request("GET", "/v1/workflows", query={"limit": limit, "cursor": cursor})

    def get(self, workflow_id: str) -> dict:
        return self._c._request("GET", f"/v1/workflows/{_id(workflow_id)}")

    def start(self, workflow_id: str, input: Optional[dict] = None, idempotency_key: Optional[str] = None) -> dict:
        """Starts a run of the published version; `input` is what {{trigger.*}} templates read."""
        return self._c._request("POST", f"/v1/workflows/{_id(workflow_id)}/executions", body={"input": input or {}}, idempotent=True,
                                idempotency_key=idempotency_key)


class _Executions(_Namespace):
    def list(self, limit: Optional[int] = None, cursor: Optional[str] = None, workflow_id: Optional[str] = None, status: Optional[str] = None) -> dict:
        return self._c._request("GET", "/v1/executions", query={"limit": limit, "cursor": cursor, "workflow_id": workflow_id, "status": status})

    def get(self, execution_id: str) -> dict:
        return self._c._request("GET", f"/v1/executions/{_id(execution_id)}")


class _Tools(_Namespace):
    def list(self) -> dict:
        return self._c._request("GET", "/v1/tools")

    def list_executions(self, limit: Optional[int] = None, cursor: Optional[str] = None, employee_id: Optional[str] = None,
                        conversation_id: Optional[str] = None) -> dict:
        query = {"limit": limit, "cursor": cursor, "employee_id": employee_id, "conversation_id": conversation_id}
        return self._c._request("GET", "/v1/tools/executions", query=query)


class _Analytics(_Namespace):
    def get(self, from_date: str, to_date: str) -> dict:
        """Dates as YYYY-MM-DD; `to_date` is exclusive."""
        return self._c._request("GET", "/v1/analytics", query={"from": from_date, "to": to_date})


# ---- Webhooks ----

class WebhookVerificationError(Exception):
    pass


def verify_webhook(payload: "bytes | str", headers: Mapping[str, str], secret: str, tolerance_sec: int = 300, now: Optional[float] = None) -> dict:
    """Checks a webhook request (Standard Webhooks) and returns its event.

    Pass the raw body exactly as received, the request headers and the endpoint's signing secret (whsec_...). Raises
    WebhookVerificationError when no signature matches or the timestamp is outside `tolerance_sec` (replays). During a
    secret rotation requests carry two signatures, so the old and the new secret both verify. Deduplicate on event["id"].
    """
    lower = {k.lower(): v for k, v in headers.items()}
    msg_id, timestamp, signatures = lower.get("webhook-id"), lower.get("webhook-timestamp"), lower.get("webhook-signature")
    if not msg_id or not timestamp or not signatures:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature")
    try:
        seconds = int(timestamp)
    except ValueError:
        raise WebhookVerificationError("The timestamp is not a number") from None
    if abs((now if now is not None else time.time()) - seconds) > tolerance_sec:
        raise WebhookVerificationError("The timestamp is too old or in the future")
    body = payload if isinstance(payload, bytes) else payload.encode()
    key = base64.b64decode(secret[len("whsec_"):] if secret.startswith("whsec_") else secret)
    expected = base64.b64encode(hmac.new(key, msg_id.encode() + b"." + timestamp.encode() + b"." + body, hashlib.sha256).digest()).decode()
    if not any(s.startswith("v1,") and hmac.compare_digest(s[3:], expected) for s in signatures.split(" ")):
        raise WebhookVerificationError("The signature does not match")
    return json.loads(body)
