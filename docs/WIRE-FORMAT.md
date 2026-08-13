# Submission wire format

`POST /submit`

Headers:
```
content-type: application/json
x-mfv2-signature: sha256=<hex hmac of the raw body, key = INGEST_HMAC_KEY>
```

Body:
```json
{
  "submission_id": "uuid-v4, generated client side",
  "body": "free text, min 10 chars, max ~60KB",
  "turnstile_token": "from the Turnstile widget",
  "meta": {
    "install_id": "opaque per-install id, used for rate limiting",
    "wallet_version": "1.15.1",
    "platform": "android | ios | extension | desktop",
    "network": "testnet | devnet | mainnet",
    "route": "/send/confirm"
  }
}
```

Responses:

| Status | Meaning |
|---|---|
| 202 | Accepted (also returned for quarantined submissions — deliberately indistinguishable) |
| 200 `duplicate_submission` | Same `submission_id` already seen. Safe retry. |
| 400 | Malformed |
| 401 | Bad HMAC |
| 403 | Turnstile failed |
| 429 | Rate limited |
| 413 | Body too large |

## Client notes

- Generate `submission_id` once per submission attempt and reuse it across
  retries. This is idempotency layer 1 — a retry with the same id will never
  produce a second report.
- The HMAC key ships in the client, so it is not a secret against a
  determined attacker. It raises the cost of casual scripted abuse; Turnstile
  and the rate limiter do the real work.
- No GitHub credential exists anywhere on the client. The wallet ships as an
  extension and a mobile app; anything in the bundle is extractable.
