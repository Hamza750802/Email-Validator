# ValidR - Email Validation Service

> **Production-ready email validation API with 5-layer verification including SMTP mailbox checks**

A comprehensive email validation service that goes beyond simple syntax checking. ValidR performs real SMTP handshakes to verify mailbox existence while using sophisticated throttling to avoid being blocked by mail servers.

**Perfect for:** SaaS applications, marketing platforms, user registration systems, and any service that needs accurate email validation.

---

## 🚀 Features

### 5-Layer Validation Pipeline

1. **Syntax Validation** - RFC 5321/5322 compliance checking
2. **DNS/MX Records** - Verifies domain can receive email
3. **Disposable Domain Detection** - Identifies temporary/burner emails
4. **Role Account Detection** - Flags generic addresses (`admin@`, `noreply@`, etc.)
5. **SMTP Mailbox Verification** - Actually connects to mail server to verify mailbox exists

### Anti-Blocking Protection

- ✅ **Per-domain throttling** - Configurable delays between requests to same domain
- ✅ **Adaptive concurrency** - Limits concurrent connections per MX server
- ✅ **Exponential backoff** - Smart retries on soft failures (4xx errors)
- ✅ **Polite identification** - Proper HELO/EHLO with real domain
- ✅ **No spam sent** - Only performs RCPT TO checks, never sends actual emails

### API Endpoints

- `GET /health` - Health check
- `GET /metrics/basic` - Validation metrics and statistics
- `POST /validate` - Validate single email
- `POST /validate-batch` - Bulk validation (up to 500 emails)

---

## 📦 Quick Start

### Option 1: Run Locally

```bash
# Clone repository
git clone <your-repo-url>
cd ValidR

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your domain settings (optional)
# Defaults work fine for testing

# Start development server
npm run dev
```

Server starts at `http://localhost:4000`

### Option 2: Run with Docker

```bash
# Build Docker image
docker build -t validr .

# Run container
docker run -p 4000:4000 \
  -e SMTP_HELO_DOMAIN=mail.yourdomain.com \
  -e SMTP_MAIL_FROM=verifier@yourdomain.com \
  validr
```

---

## 🌐 Deployment to Render

### Prerequisites
- GitHub account
- Render account (free tier available)

### Steps

1. **Push code to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin <your-github-repo>
   git push -u origin main
   ```

2. **Create new Web Service on Render**
   - Go to [Render Dashboard](https://dashboard.render.com/)
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Configure:
     - **Name**: `validr` (or your choice)
     - **Environment**: `Docker`
     - **Instance Type**: `Free` (or `Starter` for no cold starts - $7/month)

3. **Set Environment Variables** (in Render dashboard)
   ```
   NODE_ENV=production
   LOG_LEVEL=INFO
   SMTP_HELO_DOMAIN=mail.yourdomain.com
   SMTP_MAIL_FROM=verifier@yourdomain.com
   ```
   ⚠️ **Important**: Replace `yourdomain.com` with your actual domain

4. **Deploy**
   - Render will automatically build and deploy
   - Your API will be live at `https://validr.onrender.com` (or your chosen name)

### ⚡ Important Notes for Render Free Tier
- **Cold starts**: Service sleeps after 15min inactivity, takes ~30s to wake up
- **Keep-alive**: Use a cron job to ping `/health` every 10min to keep it warm
- **Upgrade to Starter ($7/month)**: No cold starts, always-on

---

## 📖 API Usage Examples

### Health Check

```bash
curl https://your-app.onrender.com/health
```

**Response:**
```json
{
  "status": "ok",
  "service": "ValidR Email Validation API",
  "version": "1.0.0",
  "timestamp": "2025-11-09T12:00:00.000Z"
}
```

### Validate Single Email

```bash
curl -X POST https://your-app.onrender.com/validate \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

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
    "validatedAt": "2025-11-09T12:00:00.000Z",
    "validationTimeMs": 1234
  }
}
```

### Skip SMTP for Faster Results

```bash
curl -X POST https://your-app.onrender.com/validate \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "skipSmtp": true
  }'
```

### Validate Batch (up to 500 emails)

```bash
curl -X POST https://your-app.onrender.com/validate-batch \
  -H "Content-Type: application/json" \
  -d '{
    "emails": [
      "user1@example.com",
      "user2@example.com",
      "admin@example.com"
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "results": [
    { "email": "user1@example.com", "score": 1.0, "smtpStatus": "valid", ... },
    { "email": "user2@example.com", "score": 0.0, "smtpStatus": "invalid", ... },
    { "email": "admin@example.com", "score": 0.85, "roleAccount": true, ... }
  ],
  "summary": {
    "total": 3,
    "valid": 1,
    "invalid": 1,
    "disposable": 0,
    "roleAccounts": 1
  }
}
```

### Get Metrics

```bash
curl https://your-app.onrender.com/metrics/basic
```

**Response:**
```json
{
  "totalValidations": 1523,
  "totalSmtpValidations": 1401,
  "smtpStatus": {
    "valid": 892,
    "invalid": 345,
    "catch_all": 98,
    "temporarily_unavailable": 24,
    "unknown": 42,
    "not_checked": 122,
    "policy_rejection": 0
  },
  "timestamp": "2025-11-09T12:00:00.000Z"
}
```

---

## ⚙️ Configuration

All configuration via environment variables. See `.env.example` for complete list.

### Critical Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4000 | HTTP server port (Render overrides this) |
| `NODE_ENV` | production | Environment mode |
| `LOG_LEVEL` | INFO | Logging level (DEBUG, INFO, WARN, ERROR) |
| `SMTP_HELO_DOMAIN` | mail.yourdomain.com | **⚠️ Set to your real domain** |
| `SMTP_MAIL_FROM` | verifier@yourdomain.com | **⚠️ Set to your real email** |

### SMTP Throttling (Advanced)

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `SMTP_MAX_GLOBAL_CONCURRENCY` | 10 | 1-100 | Max concurrent SMTP connections |
| `SMTP_MAX_MX_CONCURRENCY` | 2 | 1-10 | Max connections per MX server |
| `SMTP_PER_DOMAIN_MIN_INTERVAL_MS` | 2000 | 0+ | Delay between requests to same domain |
| `SMTP_SOFT_RETRY_LIMIT` | 2 | 0-5 | Retries on soft failures |
| `SMTP_CONNECT_TIMEOUT_MS` | 10000 | 1000-60000 | Connection timeout |
| `SMTP_OVERALL_TIMEOUT_MS` | 15000 | 5000-120000 | Total validation timeout |

**⚠️ Tuning Guidelines:**
- Start with defaults (they're conservative and safe)
- If getting blocked, reduce `SMTP_MAX_GLOBAL_CONCURRENCY` to 5
- If timeouts are common, increase timeout values
- Monitor logs for 4xx errors indicating rate limiting

---

## 🛡️ Responsible Use Warning

**SMTP validation probes real mail servers.** Irresponsible usage can result in:
- ❌ Your IP address being blocked/blacklisted
- ❌ Mail servers flagging you as a spammer
- ❌ Temporary or permanent rate limiting

### Best Practices

✅ **DO:**
- Use conservative throttling settings (defaults are good)
- Implement your own API rate limiting
- Cache validation results (24-48 hours recommended)
- Set real `SMTP_HELO_DOMAIN` and `SMTP_MAIL_FROM` values
- Monitor logs for 4xx errors
- Start with low volume and scale gradually

❌ **DON'T:**
- Validate the same email repeatedly
- Set aggressive concurrency without monitoring
- Use fake/invalid HELO domains
- Ignore retry limits and backoff settings
- Validate millions of emails without proper infrastructure

---

## 📁 Project Structure

```
src/
├── config/
│   └── env.ts                  # Environment configuration with validation
├── types/
│   └── email.ts                # TypeScript interfaces
├── validators/
│   ├── syntaxValidator.ts      # RFC 5321/5322 syntax checking
│   ├── dnsValidator.ts         # DNS/MX record lookup with caching
│   ├── disposableValidator.ts  # Disposable domain detection
│   ├── roleValidator.ts        # Role account detection
│   ├── smtpValidator.ts        # SMTP verification with throttling
│   └── scoreCalculator.ts      # Scoring algorithm
├── services/
│   └── emailValidationService.ts  # Orchestration layer
├── http/
│   ├── routes.ts               # Express API routes
│   └── server.ts               # HTTP server setup
├── utils/
│   ├── logger.ts               # Structured logging
│   ├── metrics.ts              # In-memory metrics tracking
│   ├── cache.ts                # DNS cache
│   └── throttleState.ts        # SMTP throttling state
└── cli/
    └── validateFile.ts         # CLI tool for file validation

tests/                          # Jest test suite (68 passing tests)
```

---

## 🧪 Development

### Scripts

```bash
npm run dev          # Start dev server with auto-reload
npm run build        # Compile TypeScript to dist/
npm start            # Run production build
npm test             # Run test suite
npm run test:watch   # Run tests in watch mode
npm run lint         # Lint TypeScript code
npm run validate-file <file>  # CLI tool for batch file validation
```

### CLI Tool

Validate emails from a text file (one per line):

```bash
npm run validate-file emails.txt

# Skip SMTP for faster results
npm run validate-file emails.txt --skip-smtp

# Save JSON results
npm run validate-file emails.txt --out results.json
```

---

## 🧪 Testing

68 passing tests across 5 test suites covering:
- ✅ Syntax validation
- ✅ Disposable domain detection
- ✅ Role account detection
- ✅ Score calculation
- ✅ Email validation service orchestration

```bash
npm test
```

---

## 📊 Score Interpretation

| Score | Meaning | Typical Characteristics |
|-------|---------|------------------------|
| **1.0** | ✅ Perfect | Valid syntax + MX records + real mailbox + not disposable + not role |
| **0.85-0.95** | ⚠️ Good with caveats | Catch-all server or role account |
| **0.70-0.84** | ⚠️ Questionable | Multiple issues (e.g., role + catch-all) |
| **0.50-0.69** | ❌ Poor | Disposable domain or no MX records |
| **< 0.50** | ❌ Invalid | Syntax error or mailbox doesn't exist |

---

## 🗺️ Roadmap

- [x] 5-layer validation pipeline
- [x] SMTP verification with throttling
- [x] HTTP API with batch support
- [x] CLI tool
- [x] Comprehensive test suite
- [x] Logging and metrics
- [x] Docker support
- [ ] Redis-backed caching for horizontal scaling
- [ ] User authentication & API keys
- [ ] Rate limiting per API key
- [ ] Webhook notifications
- [ ] Admin dashboard

---

## 📄 License

MIT

---

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass (`npm test`)
5. Submit a pull request

---

## 📞 Support

For issues, questions, or feature requests, please open an issue on GitHub.

**Remember:** Use this service responsibly. SMTP probing should be done with care and respect for mail server resources.
