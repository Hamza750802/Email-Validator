# ValidR API Documentation

## Overview

ValidR is a comprehensive email validation API that performs multi-layered validation including syntax, DNS/MX records, disposable domain detection, role account detection, and optional SMTP verification.

## Base URL

```
http://localhost:4000
```

## Endpoints

### 1. Health Check

**GET** `/health`

Check if the service is running.

**Response:**
```json
{
  "status": "ok",
  "service": "ValidR Email Validation API",
  "version": "1.0.0",
  "timestamp": "2025-11-09T07:22:40.509Z"
}
```

### 2. Validate Single Email

**POST** `/validate`

Validate a single email address through all validation layers.

**Request Body:**
```json
{
  "email": "user@example.com",
  "skipSmtp": false
}
```

**Parameters:**
- `email` (string, required): Email address to validate
- `skipSmtp` (boolean, optional): Skip SMTP validation for faster results. Default: `false`

**Response:**
```json
{
  "success": true,
  "result": {
    "email": "user@example.com",
    "localPart": "user",
    "domain": "example.com",
    "syntaxValid": true,
    "domainHasMx": true,
    "disposable": false,
    "roleAccount": false,
    "smtpStatus": "valid",
    "score": 1.0,
    "reasonCodes": ["syntax_valid", "mx_records_found", "non_disposable_domain", "non_role_account", "smtp_valid"],
    "validatedAt": "2025-11-09T07:22:40.509Z",
    "validationTimeMs": 1234
  }
}
```

**Error Response (400):**
```json
{
  "success": false,
  "error": "Invalid request",
  "message": "Field \"email\" is required and must be a string"
}
```

### 3. Validate Batch

**POST** `/validate-batch`

Validate multiple email addresses in a single request.

**Request Body:**
```json
{
  "emails": ["user1@example.com", "user2@example.com"],
  "skipSmtp": false
}
```

**Parameters:**
- `emails` (array of strings, required): Array of email addresses to validate (max 500)
- `skipSmtp` (boolean, optional): Skip SMTP validation for faster results. Default: `false`

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "email": "user1@example.com",
      "localPart": "user1",
      "domain": "example.com",
      "syntaxValid": true,
      "domainHasMx": true,
      "disposable": false,
      "roleAccount": false,
      "smtpStatus": "valid",
      "score": 1.0,
      "reasonCodes": ["syntax_valid", "mx_records_found"],
      "validatedAt": "2025-11-09T07:22:40.509Z",
      "validationTimeMs": 123
    },
    {
      "email": "user2@example.com",
      ...
    }
  ]
}
```

**Error Response (400 - Batch too large):**
```json
{
  "success": false,
  "error": "Batch too large",
  "message": "Maximum 500 emails allowed per batch. Received 501."
}
```

## Validation Layers

ValidR performs validation in the following order:

1. **Syntax Validation** - RFC 5321/5322 compliance
2. **DNS/MX Validation** - Domain has valid MX records
3. **Disposable Domain Detection** - Checks against 600+ known disposable email providers
4. **Role Account Detection** - Identifies 70+ common role-based addresses (admin, support, etc.)
5. **SMTP Validation** (optional) - Verifies mailbox exists via SMTP handshake

## Scoring System

The API returns a score from 0.0 to 1.0 for each email:

- **1.0**: Perfect - all checks passed including SMTP
- **0.95**: Valid but SMTP skipped
- **0.90**: Valid but catch-all server
- **0.87**: Valid but role account (e.g., admin@)
- **0.70**: Valid but disposable domain
- **0.40**: SMTP verification failed
- **0.10**: Syntax valid but no MX records
- **0.0**: Invalid syntax

### Score Penalties

- Invalid syntax: 0.0 (immediate fail)
- No MX records: score = 0.1
- Disposable domain: -0.25
- Role account: -0.08
- SMTP invalid: -0.60
- SMTP temporarily unavailable: -0.25
- SMTP catch-all: -0.10
- SMTP unknown: -0.20
- SMTP not checked: -0.05

## SMTP Status Values

- `valid`: Mailbox exists and accepts mail
- `invalid`: Mailbox rejected or doesn't exist
- `catch_all`: Server accepts all addresses (can't verify)
- `temporarily_unavailable`: Temporary error (greylisting, etc.)
- `unknown`: Connection failed or timeout
- `not_checked`: SMTP validation was skipped

## Reason Codes

Each validation includes detailed reason codes for transparency and debugging:

### Syntax Validation
- `syntax_valid` - Email format is valid per RFC 5321/5322
- `syntax_invalid` - Email format is invalid
- `syntax_invalid_format`, `syntax_invalid_characters`, `syntax_missing_at_sign`, `syntax_multiple_at_signs`, `syntax_empty_local_part`, `syntax_empty_domain`

### DNS/MX Validation
- `mx_records_found` - Domain has valid MX records
- `no_mx_records` - Domain has no MX records
- `dns_lookup_failed` - DNS query failed
- `dns_timeout` - DNS query timed out

### Disposable Domain Detection
- `disposable_domain` - Known temporary email provider
- `non_disposable_domain` - Not a disposable domain

### Role Account Detection
- `role_account` - Common role-based address (admin@, info@, etc.)
- `non_role_account` - Not a role account

### SMTP Validation

**Success/Failure:**
- `smtp_valid` - Mailbox verified via SMTP
- `smtp_invalid` - Mailbox rejected by SMTP server
- `smtp_catch_all` - Domain accepts all addresses (catch-all server)
- `smtp_temporarily_unavailable` - Temporary failure (greylisting)

**Connection Errors (NEW - Granular Diagnostics):**
- `smtp_conn_refused` - Connection refused (port 25 blocked/filtered)
- `smtp_network_unreachable` - Network/host unreachable (routing issue)
- `smtp_conn_reset` - Connection reset by peer (possibly IP-blocked)

**Phase-Specific Timeouts (NEW - Identifies WHERE it fails):**
- `smtp_banner_timeout` - Timeout waiting for 220 greeting (slow/tarpit server)
- `smtp_ehlo_timeout` - Timeout during EHLO handshake
- `smtp_mail_timeout` - Timeout during MAIL FROM command
- `smtp_rcpt_timeout` - Timeout during RCPT TO command (greylisting common here)

**Protocol Issues:**
- `smtp_tls_required` - Server requires STARTTLS (530 response)
- `smtp_tls_handshake_failed` - TLS upgrade failed (future implementation)
- `smtp_mx_all_failed` - All MX hosts failed/unreachable

**Rate Limiting & Retries:**
- `smtp_timeout` - Generic timeout (use phase-specific codes above for details)
- `smtp_connection_failed` - Generic connection error
- `smtp_greylisted` - Server greylisting detected (4xx codes)
- `smtp_rate_limited` - Rate limit detected
- `smtp_soft_fails_exceeded` - Max retries exceeded on soft failures

### Caching
- `cache_hit` - Result retrieved from cache
- `cache_miss` - Fresh validation performed

---

**💡 Tip:** Check `reasonCodes` array for detailed failure diagnostics. For example:
- `["smtp_banner_timeout"]` → Increase `SMTP_BANNER_TIMEOUT_MS`
- `["smtp_conn_refused"]` → Port 25 blocked, deploy to cloud with SMTP access
- `["smtp_rcpt_timeout", "smtp_greylisted"]` → Server greylisting, retry recommended

## Example Usage

### cURL

```bash
# Validate single email
curl -X POST http://localhost:4000/validate \
  -H "Content-Type: application/json" \
  -d '{"email":"user@gmail.com","skipSmtp":true}'

# Validate batch
curl -X POST http://localhost:4000/validate-batch \
  -H "Content-Type: application/json" \
  -d '{"emails":["user1@example.com","user2@example.com"],"skipSmtp":true}'
```

### PowerShell

```powershell
# Validate single email
$body = @{ email = "user@gmail.com"; skipSmtp = $true } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/validate" -Method POST -Body $body -ContentType "application/json"

# Validate batch
$body = @{ emails = @("user1@example.com", "user2@example.com"); skipSmtp = $true } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/validate-batch" -Method POST -Body $body -ContentType "application/json"
```

### JavaScript (fetch)

```javascript
// Validate single email
const response = await fetch('http://localhost:4000/validate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@gmail.com', skipSmtp: true })
});
const result = await response.json();

// Validate batch
const response = await fetch('http://localhost:4000/validate-batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    emails: ['user1@example.com', 'user2@example.com'], 
    skipSmtp: true 
  })
});
const results = await response.json();
```

## Performance Notes

- **Without SMTP**: ~50-200ms per email (cached MX lookups are faster)
- **With SMTP**: ~2-5 seconds per email (respects polite throttling)
- **Batch processing**: Uses concurrency limit of 5 to respect SMTP throttling
- **Caching**: MX records cached for 10 minutes, validation results for 30 minutes

## Rate Limiting & Throttling

The service implements adaptive throttling for SMTP validation:

- **Global concurrency**: Max 10 simultaneous SMTP connections
- **Per-MX concurrency**: Max 2 connections per mail server
- **Minimum interval**: 2 seconds between connections to same domain
- **Exponential backoff**: Automatic retry with increasing delays on soft failures

## Error Codes

- `400 Bad Request`: Invalid request (missing/invalid parameters)
- `404 Not Found`: Endpoint doesn't exist
- `500 Internal Server Error`: Server error during validation

## Testing

Run the test script to verify all endpoints:

```powershell
powershell -ExecutionPolicy Bypass -File test-api.ps1
```

## Starting the Server

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm run build
npm start
```

The server will start on port 4000 by default (configurable via `PORT` environment variable).
