# ValidR - Scaling & SaaS Migration Guide

> **Current Status**: Single-instance, in-memory architecture  
> **Target**: Multi-tenant SaaS with authentication, rate limiting, and billing

---

## 📊 Current Architecture (v1.0)

### Single Instance Deployment
- **Platform**: Render (free tier or $7/month starter)
- **State**: In-memory (cache, throttling, metrics)
- **Limitations**: 
  - ❌ Not shared across instances (horizontal scaling blocked)
  - ❌ Lost on restart
  - ❌ No authentication
  - ❌ No per-user rate limiting

### What Works Well
- ✅ Handles ~1,000 validations/day on single instance
- ✅ SMTP throttling prevents blocks
- ✅ Fast DNS caching
- ✅ Production-ready Docker deployment

---

## 🚀 Migration Path to Multi-Tenant SaaS

### Phase 1: Redis Migration (CRITICAL for scaling)

**When to implement**: Before scaling beyond 1 Render instance

**What to migrate**:

#### 1. Cache Layer (`src/utils/cache.ts`)
```typescript
// Current: InMemoryCache
// Target: RedisCache

// Install
npm install ioredis @types/ioredis

// Environment
REDIS_URL=redis://username:password@host:port

// Implementation (already has ICache interface)
class RedisCache implements ICache {
  private client: Redis;
  
  constructor(url: string) {
    this.client = new Redis(url);
  }
  
  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    return value ? JSON.parse(value) : null;
  }
  
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'PX', ttlMs);
  }
  
  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
  
  async clear(): Promise<void> {
    await this.client.flushdb();
  }
}

// Update factory in cache.ts
function getCacheInstance(): ICache {
  if (process.env.REDIS_URL) {
    return new RedisCache(process.env.REDIS_URL);
  }
  return new InMemoryCache();
}
```

**Key Changes**:
- Make all cache operations `async` (breaking change)
- Update all `cache.get()` calls to `await cache.get()`
- Update all validators to handle async cache

#### 2. Throttle State (`src/utils/throttleState.ts`)
```typescript
// Current: InMemoryThrottleStore
// Target: RedisThrottleStore

class RedisThrottleStore implements IThrottleStateStore {
  private client: Redis;
  
  async acquireSlot(mxHost: string, config: ThrottleConfig): Promise<void> {
    const key = `throttle:${mxHost}:concurrency`;
    const current = await this.client.incr(key);
    
    if (current === 1) {
      await this.client.expire(key, 60); // Expire in 60s
    }
    
    if (current > config.maxMxConcurrency) {
      await this.client.decr(key);
      throw new Error('Concurrency limit exceeded');
    }
  }
  
  async releaseSlot(mxHost: string): Promise<void> {
    await this.client.decr(`throttle:${mxHost}:concurrency`);
  }
  
  async recordFailure(mxHost: string, shouldPenalize: boolean): Promise<void> {
    if (shouldPenalize) {
      const penaltyMs = 60000; // 1 minute
      await this.client.set(
        `throttle:${mxHost}:penalty`,
        Date.now() + penaltyMs,
        'PX',
        penaltyMs
      );
    }
  }
}
```

**Key Changes**:
- Atomic operations prevent race conditions
- Penalties persist across instances
- Global concurrency enforced with sorted sets

#### 3. Metrics (`src/utils/metrics.ts`)
```typescript
// Use Redis INCR for atomic counters
class RedisMetrics {
  async incrementValidations(): Promise<void> {
    await this.client.incr('metrics:total_validations');
  }
  
  async recordSmtpValidation(status: string): Promise<void> {
    await this.client.hincrby('metrics:smtp_status', status, 1);
  }
  
  async getMetrics(): Promise<MetricsCounts> {
    const total = await this.client.get('metrics:total_validations');
    const smtpStatus = await this.client.hgetall('metrics:smtp_status');
    return { totalValidations: parseInt(total || '0'), smtpStatus, ... };
  }
}
```

**Redis Providers**:
- **Upstash** (recommended): Serverless, free tier, global edge
- **Redis Cloud**: Free 30MB tier
- **Render Redis**: $7/month, same platform

---

### Phase 2: Authentication & API Keys

**When to implement**: Before making API public

**Components to add**:

#### 1. Database (PostgreSQL recommended)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  tier VARCHAR(20) NOT NULL DEFAULT 'free',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  key_hash VARCHAR(255) NOT NULL UNIQUE,
  key_prefix VARCHAR(10) NOT NULL, -- First 8 chars for display
  name VARCHAR(100),
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  revoked_at TIMESTAMP
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
```

#### 2. Authentication Middleware (`src/middleware/auth.ts`)
```typescript
import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { RequestContext, SubscriptionTier } from '../types/context';

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Allow unauthenticated requests with free tier limits
    req.context = {
      tier: SubscriptionTier.FREE,
      requestId: generateRequestId(),
      ipAddress: req.ip,
    };
    return next();
  }
  
  const apiKey = authHeader.substring(7);
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  
  // TODO: Query database for api_keys table
  const apiKeyRecord = await db.query(
    'SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
    [keyHash]
  );
  
  if (!apiKeyRecord) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  // TODO: Update last_used_at
  // TODO: Fetch user tier from users table
  
  req.context = {
    userId: apiKeyRecord.user_id,
    apiKeyId: apiKeyRecord.id,
    tier: apiKeyRecord.user_tier,
    requestId: generateRequestId(),
  };
  
  next();
}
```

#### 3. Update Routes (`src/http/routes.ts`)
```typescript
import { authMiddleware } from '../middleware/auth';

// Apply to all routes
router.use(authMiddleware);

// Pass context to validation
router.post('/validate', async (req: Request, res: Response) => {
  const result = await validateEmail(req.body.email, {
    skipSmtp: req.body.skipSmtp,
    context: req.context, // Now includes user/tier info
  });
  res.json({ success: true, result });
});
```

---

### Phase 3: Rate Limiting & Quotas

**When to implement**: With authentication (Phase 2)

**Implementation**:

#### 1. Redis-based Rate Limiter
```typescript
// src/middleware/rateLimit.ts
import { RATE_LIMIT_PROFILES } from '../config/env';

export async function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const context = req.context!;
  const profile = RATE_LIMIT_PROFILES[context.tier];
  
  // Check daily quota (using Redis)
  const key = `quota:daily:${context.userId || context.ipAddress}:${getToday()}`;
  const count = await redis.incr(key);
  
  if (count === 1) {
    await redis.expire(key, 86400); // 24 hours
  }
  
  if (profile.dailyQuota > 0 && count > profile.dailyQuota) {
    return res.status(429).json({
      error: 'Daily quota exceeded',
      quota: profile.dailyQuota,
      used: count,
      resetAt: getNextDayTimestamp(),
    });
  }
  
  // Check rate limit (requests per minute)
  const rateLimitKey = `ratelimit:${context.userId || context.ipAddress}`;
  const windowMs = 60000; // 1 minute
  const maxRequests = profile.maxGlobalConcurrency * 10; // 10x concurrency
  
  const requests = await redis.incr(rateLimitKey);
  if (requests === 1) {
    await redis.pexpire(rateLimitKey, windowMs);
  }
  
  if (requests > maxRequests) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      limit: maxRequests,
      window: '1 minute',
    });
  }
  
  next();
}
```

#### 2. Apply Tier-based SMTP Limits
```typescript
// src/utils/throttleState.ts
export async function acquireSlot(
  mxHost: string,
  config: ThrottleConfig,
  context?: RequestContext
): Promise<void> {
  // Use tier-specific limits if context provided
  if (context) {
    const profile = RATE_LIMIT_PROFILES[context.tier];
    config = {
      ...config,
      maxGlobalConcurrency: profile.maxGlobalConcurrency,
      maxMxConcurrency: profile.maxMxConcurrency,
      perDomainMinIntervalMs: profile.perDomainMinIntervalMs,
    };
  }
  
  // Rest of acquisition logic...
}
```

---

### Phase 4: Billing & Subscriptions

**When to implement**: After Phase 2 & 3

**Tools**:
- **Stripe**: Payment processing, subscription management
- **Paddle**: Alternative with built-in tax handling

**Database Schema**:
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  stripe_subscription_id VARCHAR(255) UNIQUE,
  tier VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL, -- active, canceled, past_due
  current_period_start TIMESTAMP NOT NULL,
  current_period_end TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE usage_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  api_key_id UUID REFERENCES api_keys(id),
  email VARCHAR(255) NOT NULL,
  smtp_status VARCHAR(50),
  validation_time_ms INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_usage_logs_user_date ON usage_logs(user_id, created_at);
```

**Integration**:
```typescript
// Stripe webhook handler
router.post('/webhooks/stripe', async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  
  switch (event.type) {
    case 'customer.subscription.created':
      // Update users table with new tier
      break;
    case 'customer.subscription.deleted':
      // Downgrade to free tier
      break;
    case 'invoice.payment_failed':
      // Handle failed payment
      break;
  }
  
  res.json({ received: true });
});
```

---

## 🔌 Integration Points Summary

### Where to Plug In Redis

| Component | File | Interface | Migration Priority |
|-----------|------|-----------|-------------------|
| **Cache** | `src/utils/cache.ts` | `ICache` | 🔴 HIGH (enables scaling) |
| **Throttle State** | `src/utils/throttleState.ts` | `IThrottleStateStore` | 🔴 HIGH (prevents race conditions) |
| **Metrics** | `src/utils/metrics.ts` | `MetricsCollector` | 🟡 MEDIUM (improves accuracy) |

### Where to Plug In Authentication

| Component | File | Purpose |
|-----------|------|---------|
| **Middleware** | `src/middleware/auth.ts` | Validate API keys, attach context |
| **Routes** | `src/http/routes.ts` | Apply auth middleware, pass context |
| **Service** | `src/services/emailValidationService.ts` | Use context.tier for limits |
| **Database** | SQL migrations | Store users, api_keys, subscriptions |

### Where to Plug In Rate Limiting

| Component | File | Purpose |
|-----------|------|---------|
| **Middleware** | `src/middleware/rateLimit.ts` | Check quota/rate limits |
| **Config** | `src/config/env.ts` | Tier-based profiles (already defined) |
| **Throttle** | `src/utils/throttleState.ts` | Apply tier limits to SMTP |
| **Redis** | Rate limit keys | `ratelimit:{userId}`, `quota:daily:{userId}:{date}` |

### Where to Plug In Billing

| Component | Purpose |
|-----------|---------|
| **Stripe SDK** | Payment processing |
| **Webhook Handler** | `POST /webhooks/stripe` - Handle subscription events |
| **Database** | Track subscriptions, usage logs |
| **Admin Dashboard** | Manage users, view usage, override limits |

---

## 📈 Scaling Checklist

### Before Scaling to 2+ Instances
- [ ] Migrate cache to Redis
- [ ] Migrate throttle state to Redis
- [ ] Migrate metrics to Redis
- [ ] Test with multiple instances locally (Docker Compose)
- [ ] Verify concurrency limits work across instances

### Before Making API Public
- [ ] Implement authentication
- [ ] Implement rate limiting
- [ ] Add API key management UI
- [ ] Set up error tracking (Sentry)
- [ ] Add monitoring (Datadog/New Relic)
- [ ] Write API documentation
- [ ] Create pricing page

### Before Charging Money
- [ ] Implement Stripe integration
- [ ] Add subscription management UI
- [ ] Set up usage tracking
- [ ] Create billing dashboard
- [ ] Add email notifications (payment failed, quota warnings)
- [ ] Write terms of service
- [ ] Add GDPR compliance (data export/deletion)

---

## 💰 Estimated Costs (Monthly)

### Development/MVP
- Render Web Service (Starter): $7
- PostgreSQL (Render): $7
- Redis (Upstash Free): $0
- **Total**: ~$14/month

### Production (1,000 users)
- Render Web Service (Pro, 2 instances): $50
- PostgreSQL (Render Pro): $50
- Redis (Upstash Pro): $40
- Stripe fees (~3%): Variable
- **Total**: ~$140/month + Stripe fees

### Scale (10,000+ users)
- Dedicated infrastructure
- Multi-region deployment
- Managed Redis cluster
- Consider AWS/GCP for cost optimization

---

## 🎯 Recommended Approach

1. **Launch v1.0** - Current architecture on Render (free/starter tier)
2. **Validate market** - Get first 100 users, collect feedback
3. **Phase 1** - Migrate to Redis when scaling beyond 1 instance
4. **Phase 2** - Add authentication when ready to monetize
5. **Phase 3** - Add rate limiting with auth
6. **Phase 4** - Implement billing when revenue validates model

**Don't over-engineer early** - Current architecture supports:
- ✅ 1,000+ validations/day
- ✅ Single Render instance
- ✅ Proof of concept
- ✅ Early adopters

Migrate to Redis/auth/billing when you **actually need it**, not before.
