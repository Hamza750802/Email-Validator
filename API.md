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

Each validation includes detailed reason codes:

**Syntax:**
- `syntax_valid`, `syntax_invalid`

**DNS/MX:**
- `mx_records_found`, `no_mx_records`, `dns_lookup_failed`

**Disposable:**
- `disposable_domain`, `non_disposable_domain`

**Role:**
- `role_account`, `non_role_account`

**SMTP:**
- `smtp_valid`, `smtp_invalid`, `smtp_catch_all`, `smtp_temporarily_unavailable`, `smtp_timeout`, etc.

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
