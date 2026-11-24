# workforce-sdk (Python)

Python client for the AI Workforce public API (`/v1`). Standard library only, Python 3.9+.

```python
import os
from workforce_sdk import Client, verify_webhook

wf = Client(api_key=os.environ["WORKFORCE_API_KEY"], base_url="https://api.example.com")

answer = wf.employees.send_message("EMPLOYEE_ID", message="What are your hours?", customer="rahul@example.com")
print(answer["reply"]["text"])

for event in wf.employees.stream_message("EMPLOYEE_ID", message="Hi"):
    if event["type"] == "text":
        print(event["text"], end="")

for conversation in wf.paginate(wf.conversations.list, employee_id="EMPLOYEE_ID"):
    print(conversation["title"])

# In your webhook handler: the raw body, the headers, the endpoint's signing secret.
event = verify_webhook(raw_body, request_headers, os.environ["WORKFORCE_WEBHOOK_SECRET"])
```

Keyword arguments use Python names (`employee_id`, `time_zone`); the SDK sends the API's names. Errors raise
`WorkforceError` (`status`, `type`, `issues`, `request_id`). Reads, and writes that carry an idempotency key (the SDK adds
one), are retried after network errors, 429 and 5xx. The full contract is `GET /v1/openapi.json`.

Publish: `python -m build` then `twine upload dist/*` (needs a PyPI account; check that the name `workforce-sdk` is yours).
