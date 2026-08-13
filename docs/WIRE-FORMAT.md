# Submission wire format

`POST /submit`

The request is **`multipart/form-data`**, not JSON — it has to carry an
attachment, and base64 in a JSON body would inflate a 10 MB video by a third.

Headers:
```
content-type: multipart/form-data; boundary=...   (set by the browser, not by hand)
x-mfv2-signature: sha256=<hex hmac of the canonical string, key = INGEST_HMAC_KEY>
```

Form fields:

| Field | Required | Notes |
|---|---|---|
| `submission_id` | ✅ | uuid-v4, generated client side |
| `body` | ✅ | free text, min 10 chars, max ~60KB |
| `platform` | ✅ | `android` \| `mobile` \| `extension` |
| `turnstile_token` | ✅ | from the Turnstile widget |
| `meta` | — | JSON string: `install_id`, `wallet_version`, `network`, `route` |
| `attachment` | — | one file, ≤10 MB, `image/png` \| `image/jpeg` \| `video/mp4` |

## Signing

The signature covers a **canonical subset**, not the raw request body. A
browser cannot hand its own code the exact bytes `fetch` will serialize for a
`FormData` — the multipart boundary is chosen inside `fetch` — so a raw-body
MAC would be unverifiable on the client side without hand-rolling multipart.

Canonical string, joined by newlines:

```
mfv2.v1
<submission_id>
<sha256 hex of the body field>
<platform>
```

Signed as HMAC-SHA-256 with `INGEST_HMAC_KEY`, sent hex-encoded and prefixed
with `sha256=`. The Worker recomputes it from the parsed form fields and
rejects a mismatch with 401.

The scheme is versioned by its first line. Changing what is covered means
bumping `mfv2.v1`, so a stale client fails closed rather than silently
sending a signature over the wrong thing.

**What the signature does NOT cover:** the attachment bytes, `meta`, and the
Turnstile token. A tampered attachment is caught by the type/size validation
and the secret scanner, not by the MAC. Do not extend the canonical string to
cover the attachment — hashing 10 MB on the client is exactly the kind of work
the free-tier CPU budget cannot absorb.

Responses:

| Status | Meaning |
|---|---|
| 202 | Accepted (also returned for quarantined submissions — deliberately indistinguishable) |
| 200 `duplicate_submission` | Same `submission_id` already seen. Safe retry. |
| 400 | Malformed |
| 401 | Bad or missing signature |
| 403 | Turnstile failed |
| 429 | Rate limited |
| 413 | Attachment too large or wrong type |

## Client notes

- Generate `submission_id` once per submission attempt and reuse it across
  retries. This is idempotency layer 1 — a retry with the same id will never
  produce a second report.
- **The HMAC key ships in the client, so it is not a secret against a
  determined attacker.** It raises the cost of casual scripted abuse;
  Turnstile and the rate limiter do the real work. Never treat a valid
  signature as evidence of anything about the sender.
- Set only the signature header by hand. Letting `fetch` write its own
  `content-type` is what puts the multipart boundary in it; overriding it
  breaks parsing server-side.
- No GitHub credential exists anywhere on the client. The wallet ships as an
  extension and a mobile app; anything in the bundle is extractable.
