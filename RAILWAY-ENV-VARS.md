# 🚂 Railway Environment Variables - COPY THESE

**Go to Railway Dashboard → Your Project → Variables tab → Paste these:**

---

## ✅ **Required Variables**

```bash
# Server
NODE_ENV=production
PORT=8080

# SMTP Configuration - CRITICAL TIMEOUTS
SMTP_CONNECT_TIMEOUT_MS=30000
SMTP_OVERALL_TIMEOUT_MS=45000

# Per-Phase Timeouts (must sum < 45000ms)
SMTP_BANNER_TIMEOUT_MS=8000
SMTP_EHLO_TIMEOUT_MS=8000
SMTP_MAIL_TIMEOUT_MS=8000
SMTP_RCPT_TIMEOUT_MS=15000

# SMTP Concurrency (conservative for Railway)
SMTP_MAX_GLOBAL_CONCURRENCY=5
SMTP_MAX_MX_CONCURRENCY=2
SMTP_PER_DOMAIN_MIN_INTERVAL_MS=3000

# SMTP Retry
SMTP_SOFT_RETRY_LIMIT=2
SMTP_INITIAL_RETRY_DELAY_MS=5000
SMTP_RETRY_BACKOFF_FACTOR=3

# SMTP Identity (IMPORTANT - change yourdomain.com to your actual domain)
SMTP_HELO_DOMAIN=mail.yourdomain.com
SMTP_MAIL_FROM=verifier@yourdomain.com

# TLS Configuration
SMTP_REQUIRE_TLS=false
SMTP_ALLOW_TLS_DOWNGRADE=true

# MX Strategy
SMTP_MAX_MX_ATTEMPTS=5
SMTP_RANDOMIZE_SAME_PRIORITY=true

# Redis (use Railway Redis plugin)
REDIS_ENABLED=true
REDIS_URL=${{Redis.REDIS_URL}}
REDIS_KEY_PREFIX=validr:
REDIS_CACHE_TTL_SECONDS=3600
REDIS_THROTTLE_TTL_SECONDS=300

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_SKIP_SUCCESSFUL=false

# Batch Processing
BATCH_SIZE_LIMIT=1000
BATCH_TIMEOUT_MS=300000
```

---

## 🔧 **How to Set These**

### **Option 1: Railway Dashboard (Recommended)**
1. Go to https://railway.app/dashboard
2. Select your project
3. Click **"Variables"** tab
4. Click **"RAW Editor"**
5. **Copy-paste all variables above**
6. Click **"Save"**

### **Option 2: Railway CLI**
```powershell
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to project
railway link

# Add Redis
railway add

# Set variables (paste ALL variables above one by one)
railway variables set SMTP_OVERALL_TIMEOUT_MS=45000
railway variables set SMTP_BANNER_TIMEOUT_MS=8000
# ... etc
```

---

## ⚠️ **Critical Fixes**

### **1. Fix Timeout Warning**
Current Railway config has:
- `SMTP_OVERALL_TIMEOUT_MS=15000` ❌ TOO LOW
- Phase timeouts sum to 20000ms

**Solution:** Set `SMTP_OVERALL_TIMEOUT_MS=45000` ✅

---

### **2. Add Redis Plugin**
**In Railway Dashboard:**
1. Click **"New"** → **"Database"** → **"Add Redis"**
2. Railway will auto-create `${{Redis.REDIS_URL}}`
3. Your app will auto-connect (no manual URL needed)

**OR disable Redis:**
```bash
REDIS_ENABLED=false
```

---

### **3. Fix Disposable Domains**
The file is missing in production. Quick fix:

**Option A:** Disable disposable check temporarily
```bash
# In Railway Variables, add:
SKIP_DISPOSABLE_CHECK=true
```

**Option B:** Ensure file is copied in build
Dockerfile already copies it, but verify `data/disposable-domains.json` exists in repo.

---

## 🎯 **Minimal Required Variables (If Short on Time)**

If you want to deploy quickly, set AT MINIMUM:

```bash
NODE_ENV=production
PORT=8080
SMTP_OVERALL_TIMEOUT_MS=45000
SMTP_BANNER_TIMEOUT_MS=8000
SMTP_EHLO_TIMEOUT_MS=8000
SMTP_MAIL_TIMEOUT_MS=8000
SMTP_RCPT_TIMEOUT_MS=15000
SMTP_HELO_DOMAIN=mail.yourdomain.com
SMTP_MAIL_FROM=verifier@yourdomain.com
REDIS_ENABLED=false
```

---

## 🚀 **After Setting Variables**

Railway will **auto-redeploy**. Monitor:
```powershell
railway logs --follow
```

Or check Railway dashboard → Deployments → Latest deployment logs

---

## 📊 **Expected Results**

After fixes:
- ✅ No timeout warning (45000ms > 39000ms sum)
- ✅ Redis optional (falls back to in-memory)
- ✅ Disposable domains optional (uses fallback list)
- ✅ SMTP validation works with new timeouts

**Test with:** Upload 1-2 test emails first, then your 320 leads.
