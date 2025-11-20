# SMTP Optimization Quick Reference

## 🎯 What We Fixed

| Problem | Solution | Impact |
|---------|----------|--------|
| **100% SMTP timeouts** | Per-phase timeouts + error taxonomy | Identify WHERE failures occur |
| **"Connection failed" everywhere** | 12 specific error codes | Actionable diagnostics |
| **Can't distinguish tarpit from real timeout** | Banner/EHLO/MAIL/RCPT separate timeouts | Detect greylisting vs blocks |
| **All traffic to primary MX** | Randomize same-priority MXes | Load distribution |
| **Testing all 20 MX records** | Limit to 5 attempts | 3x faster failures |
| **Catch-all fails if first MX down** | Test on first reachable MX | More accurate detection |
| **TLS-required servers marked invalid** | Detect 530 code, return unknown | No false negatives |

---

## 📋 New Environment Variables (Copy-Paste)

```bash
# Per-Phase Timeouts (Critical for Railway!)
SMTP_BANNER_TIMEOUT_MS=5000
SMTP_EHLO_TIMEOUT_MS=5000
SMTP_MAIL_TIMEOUT_MS=5000
SMTP_RCPT_TIMEOUT_MS=5000

# MX Strategy
SMTP_MAX_MX_ATTEMPTS=5
SMTP_RANDOMIZE_SAME_PRIORITY=true

# STARTTLS (Future)
SMTP_REQUIRE_TLS=false
SMTP_ALLOW_TLS_DOWNGRADE=true
```

---

## 🔍 New Error Codes Cheat Sheet

### Network Errors
- `smtp_conn_refused` → Port 25 blocked/filtered (change platform)
- `smtp_network_unreachable` → Routing issue (DNS/firewall problem)
- `smtp_conn_reset` → IP blocked by mail server

### Phase-Specific Timeouts
- `smtp_banner_timeout` → Server slow to greet (increase timeout or skip)
- `smtp_ehlo_timeout` → Greylisting at EHLO phase
- `smtp_mail_timeout` → Rate limiting at MAIL FROM
- `smtp_rcpt_timeout` → Tarpit at RCPT TO (increase timeout)

### Protocol Issues
- `smtp_tls_required` → Server needs STARTTLS (return unknown, not invalid)
- `smtp_tls_handshake_failed` → TLS upgrade failed (future implementation)
- `smtp_mx_all_failed` → All MX hosts unreachable

---

## 🚀 Railway Deployment Commands

```powershell
# 1. Install CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Create project
railway init

# 4. Add Redis
railway add

# 5. Set variables (critical ones)
railway variables set SMTP_BANNER_TIMEOUT_MS=5000
railway variables set SMTP_EHLO_TIMEOUT_MS=5000
railway variables set SMTP_MAIL_TIMEOUT_MS=5000
railway variables set SMTP_RCPT_TIMEOUT_MS=5000
railway variables set SMTP_MAX_MX_ATTEMPTS=5

# 6. Deploy
railway up

# 7. Generate URL
railway domain

# 8. Watch logs
railway logs --follow
```

---

## 📊 Expected Results

| Metric | Before (Localhost) | After (Railway) |
|--------|-------------------|-----------------|
| **SMTP Success** | 0% | 70-85% |
| **Overall Accuracy** | 80% (no SMTP) | 88-92% |
| **Avg Validation Time** | 10-60s (timeouts) | 5-10s |
| **Error Specificity** | Generic | 12 distinct codes |

---

## 🔧 Tuning Guide

### If SMTP success < 50%

1. **Check error distribution:**
   ```powershell
   railway logs | grep "smtp_" | sort | uniq -c | sort -rn
   ```

2. **Common fixes:**
   - `smtp_conn_refused` > 50% → Request PTR record from Railway
   - `smtp_banner_timeout` > 30% → Increase to 10000ms
   - `smtp_rcpt_timeout` > 20% → Increase to 10000ms, enable more retries

3. **If still failing:** Switch to DigitalOcean ($6/month, better port 25 access)

### If validations are too slow

1. **Reduce timeouts:**
   ```bash
   SMTP_BANNER_TIMEOUT_MS=3000
   SMTP_EHLO_TIMEOUT_MS=3000
   SMTP_MAIL_TIMEOUT_MS=3000
   SMTP_RCPT_TIMEOUT_MS=3000
   ```

2. **Increase concurrency:**
   ```bash
   SMTP_MAX_GLOBAL_CONCURRENCY=20
   SMTP_MAX_MX_CONCURRENCY=3
   ```

3. **Reduce MX attempts:**
   ```bash
   SMTP_MAX_MX_ATTEMPTS=3
   ```

---

## 🎓 Key Learnings

1. **Port 25 is the bottleneck**
   - Residential IPs: Blocked by ISPs
   - Cloud platforms: Vary widely (Railway > Render)
   - Solution: Deploy to cloud with good port 25 access

2. **Timeouts matter more than you think**
   - Single timeout = blind (no clue where it hangs)
   - Per-phase timeouts = actionable (know if banner/EHLO/RCPT)
   - Trade-off: Too short = false unknowns, too long = slow

3. **Error codes are gold**
   - Generic "failed" = useless
   - Specific "ECONNREFUSED" = "change platform"
   - Enables data-driven optimization

4. **MX strategy impacts success**
   - Strict priority = all traffic to primary = overload
   - Randomization = load spread = fewer blocks
   - Limit attempts = faster failures = better UX

---

## ✅ Ready to Deploy Checklist

- [x] Code builds: `npm run build`
- [x] Environment variables documented
- [x] Railway CLI installed
- [ ] Railway account created
- [ ] Redis service added
- [ ] Environment variables set
- [ ] App deployed
- [ ] Public URL generated
- [ ] 320 leads tested
- [ ] Results analyzed

---

## 📞 Next Actions

1. **Deploy to Railway** (15 minutes)
   ```powershell
   railway login; railway init; railway add; railway up; railway domain
   ```

2. **Test with 320 leads** (10 minutes)
   - Upload CSV to Railway URL
   - Download results
   - Check `smtpStatus` distribution

3. **Analyze & Tune** (30 minutes)
   - Count error codes
   - Adjust timeouts if needed
   - Request PTR record if conn_refused > 50%

4. **Implement Provider Heuristics** (Phase 1.3, 2-3 hours)
   - Gmail: Parse "does not exist" vs "disabled"
   - Outlook: Quota exceeded vs invalid
   - Yahoo: Rate limit detection

---

**Total Time to Production:** 1 hour  
**Expected SMTP Success:** 70-85%  
**Expected Accuracy:** 88-92%
