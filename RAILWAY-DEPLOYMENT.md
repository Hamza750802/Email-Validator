# Railway.app Deployment Guide for ValidR

## Quick Start (15 Minutes)

### Prerequisites
- Node.js 20+ installed
- Git repository with latest code
- Railway.app account (free)

---

## Step-by-Step Deployment

### 1. Install Railway CLI

```powershell
npm install -g @railway/cli
```

### 2. Login to Railway

```powershell
railway login
```

This opens your browser for authentication.

### 3. Initialize Project

```powershell
# Navigate to your project
cd D:\ValidR

# Create Railway project
railway init

# Select "Create new project"
# Name it: ValidR
```

### 4. Add Redis

```powershell
railway add
```

- Select: **Redis**
- Railway automatically sets `REDIS_URL` environment variable

### 5. Configure Environment Variables

```powershell
# Copy all environment variables
railway variables set PORT=4000
railway variables set LOG_LEVEL=info
railway variables set NODE_ENV=production

# SMTP Core Settings
railway variables set SMTP_MAX_GLOBAL_CONCURRENCY=10
railway variables set SMTP_MAX_MX_CONCURRENCY=2
railway variables set SMTP_PER_DOMAIN_MIN_INTERVAL_MS=2000

# SMTP Timeouts (NEW - Critical!)
railway variables set SMTP_CONNECT_TIMEOUT_MS=10000
railway variables set SMTP_OVERALL_TIMEOUT_MS=15000
railway variables set SMTP_BANNER_TIMEOUT_MS=5000
railway variables set SMTP_EHLO_TIMEOUT_MS=5000
railway variables set SMTP_MAIL_TIMEOUT_MS=5000
railway variables set SMTP_RCPT_TIMEOUT_MS=5000

# SMTP Retry Logic
railway variables set SMTP_SOFT_RETRY_LIMIT=2
railway variables set SMTP_INITIAL_RETRY_DELAY_MS=5000
railway variables set SMTP_RETRY_BACKOFF_FACTOR=3

# MX Probing Strategy (NEW!)
railway variables set SMTP_MAX_MX_ATTEMPTS=5
railway variables set SMTP_RANDOMIZE_SAME_PRIORITY=true

# SMTP Identity
railway variables set SMTP_HELO_DOMAIN=mail.validr.app
railway variables set SMTP_MAIL_FROM=verifier@validr.app

# Redis (auto-set by Railway, but can override)
# railway variables set REDIS_ENABLED=true
# railway variables set REDIS_URL=<set-by-railway>

# Batch limits
railway variables set MAX_BATCH_SIZE=1000
```

### 6. Deploy

```powershell
railway up
```

**What happens:**
- Railway builds Docker image from your code
- Deploys to cloud infrastructure
- Starts your service
- Connects to Redis

**Build time:** ~3-5 minutes

### 7. Generate Public URL

```powershell
railway domain
```

This creates a URL like: `https://validr-production.up.railway.app`

### 8. View Live Logs

```powershell
railway logs --follow
```

Or visit Railway dashboard.

---

## Verify Deployment

### 1. Test Health Endpoint

```powershell
curl https://validr-production.up.railway.app/
```

Expected response:
```json
{
  "message": "Email Validation Service API",
  "version": "1.0.0",
  "endpoints": {
    "single": "POST /validate",
    "batch": "POST /upload-csv"
  }
}
```

### 2. Test Single Email Validation

```powershell
curl -X POST https://validr-production.up.railway.app/validate `
  -H "Content-Type: application/json" `
  -d '{"email": "test@gmail.com"}'
```

**Look for:**
- `smtpStatus`: Should NOT be "unknown" for most emails
- `score`: Should be higher than 0.8 for valid emails
- `reasonCodes`: Check for specific error codes (not generic failures)

### 3. Upload 320 Leads CSV

1. Open `https://validr-production.up.railway.app` in browser
2. Upload your `test-emails.csv`
3. Watch logs: `railway logs --follow`
4. Download results when complete

**Expected Results:**
- **SMTP Success:** 70-85% (vs 0% on localhost)
- **Overall Accuracy:** 88-92%
- **Time:** ~5-10 minutes for 326 emails

---

## Post-Deployment Checks

### 1. Monitor Error Distribution

Check logs for:

```
[INFO] Validation complete
{
  "emailHash": "abc123",
  "domain": "gmail.com",
  "score": 0.92,
  "smtpStatus": "valid",  ← Should see more "valid" than "unknown"
  "timeMs": 3421
}
```

### 2. Identify Common Failures

```
# Look for patterns:
grep "smtp_banner_timeout" railway.log | wc -l    # Banner timeouts
grep "smtp_conn_refused" railway.log | wc -l      # Port 25 blocked
grep "smtp_rcpt_timeout" railway.log | wc -l      # Greylisting
```

**If you see high counts:**
- `smtp_banner_timeout` > 30%: Increase `SMTP_BANNER_TIMEOUT_MS` to 10000
- `smtp_conn_refused` > 50%: Railway IP blocked, request PTR record from support
- `smtp_network_unreachable` > 20%: Network routing issue, open support ticket

### 3. Check Redis Connection

```powershell
railway logs | grep "Redis"
```

Should see:
```
[INFO] Redis client connected successfully
[DEBUG] Redis client ready to accept commands
```

---

## Troubleshooting

### SMTP Still Failing (>80% unknown)

**Option 1: Request Reverse DNS (PTR Record)**

Email Railway support:
```
Subject: Request Reverse DNS (PTR) for Email Validation Service

Hi Railway team,

I'm running an email validation service (ValidR) that connects to mail 
servers on port 25 for SMTP verification. To improve deliverability 
and avoid being blocked, I need reverse DNS (PTR record) configured 
for my app's IP address.

Project: ValidR
Service ID: <your-service-id>
URL: https://validr-production.up.railway.app

Can you enable/configure PTR records for my assigned IP?

Thanks!
```

**Option 2: Switch to DigitalOcean**

If Railway doesn't help:
```bash
# DigitalOcean has better port 25 support
# $6/month droplet
# 2-3 hours setup time
# 85-90% SMTP success
```

### Build Failures

**Error:** `Module not found`
```powershell
# Make sure all dependencies are in package.json
npm install
git add package.json package-lock.json
git commit -m "Update dependencies"
git push
railway up
```

**Error:** `TypeScript compilation failed`
```powershell
# Build locally first
npm run build
# Fix any errors, then:
git push
railway up
```

### Redis Connection Issues

```powershell
# Check Redis service status
railway status

# Restart Redis
railway restart -s redis

# Check REDIS_URL is set
railway variables
```

---

## Auto-Deploy from GitHub

### Enable Continuous Deployment

```powershell
# Link Railway to GitHub repo
railway link

# Select your repository
# Choose branch: main

# Now every git push deploys automatically!
```

### Test Auto-Deploy

```powershell
# Make a small change
echo "# Test" >> README.md
git add README.md
git commit -m "Test auto-deploy"
git push

# Watch Railway dashboard - build starts automatically
railway logs --follow
```

---

## Scaling & Performance

### Monitor Resource Usage

```powershell
railway metrics
```

**Key Metrics:**
- **CPU:** Should be <50% under normal load
- **Memory:** ~200-300MB for basic usage
- **Network:** Outbound traffic to mail servers

### Scale Up if Needed

Railway auto-scales, but you can manually adjust:

```powershell
# In Railway dashboard:
# Settings → Resources
# Increase memory to 1GB if batches are large
```

---

## Cost Estimates

### Free Tier
- **Credit:** $5/month
- **Usage:** ~500-1000 validations/day
- **Good for:** Testing, personal use

### Paid Tier (After Free Credit)
- **Compute:** ~$5-10/month (based on usage)
- **Redis:** ~$5/month
- **Total:** ~$10-15/month

**Much cheaper than:**
- NeverBounce API: $16/month for 2000 emails
- ZeroBounce: $16/month for 2000 emails

---

## Success Criteria

After deployment, you should see:

✅ **SMTP Success:** 70-85% (was 0%)  
✅ **Overall Accuracy:** 88-92% (was 80%)  
✅ **Validation Time:** 5-10s per email  
✅ **Error Codes:** Specific (not generic)  
✅ **Logs:** Detailed phase-by-phase info  
✅ **Redis:** Connected and caching  

---

## Next Steps After Successful Deployment

1. **Analyze 320 Leads Results**
   - Download CSV
   - Check `smtpStatus` distribution
   - Identify patterns in failures

2. **Tune Configuration**
   - Adjust timeouts based on data
   - Modify concurrency if rate-limited
   - Update MX attempt limits

3. **Implement Provider Heuristics** (Phase 1.3)
   - Gmail-specific validation
   - Outlook response parsing
   - Yahoo rate limit handling

4. **Add Custom Domain**
   ```powershell
   railway domain add validr.yourdomain.com
   ```

5. **Set Up Monitoring**
   - Railway metrics dashboard
   - Error alerting
   - Usage analytics

---

## Support

**Railway Docs:** https://docs.railway.app/  
**Railway Discord:** https://discord.gg/railway  
**ValidR Issues:** https://github.com/Hamza750802/Email-Validator/issues

---

**Status:** Ready to deploy!  
**Time Required:** 15 minutes  
**Next Command:** `railway login`
