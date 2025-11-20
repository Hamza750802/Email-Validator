/**
 * Environment configuration loader with validation.
 * All configuration comes from environment variables with sensible defaults.
 * Fails fast on critical misconfigurations.
 * 
 * FUTURE SAAS FEATURES:
 *   - Tier-based rate limit profiles (free, standard, premium)
 *   - Per-user/API-key configuration overrides
 *   - Dynamic config updates via admin dashboard
 */

import dotenv from 'dotenv';
import { join } from 'path';
import { SubscriptionTier } from '../types/context';
import { logger } from '../utils/logger';

// Load .env file from root directory
dotenv.config({ path: join(__dirname, '../../.env') });

interface Config {
  // Server
  port: number;
  nodeEnv: string;

  // Redis Configuration
  redis: {
    enabled: boolean;                   // Enable Redis (falls back to in-memory if false or connection fails)
    url: string;                        // Redis connection URL (redis://host:port)
    keyPrefix: string;                  // Prefix for all Redis keys (namespace isolation)
    cacheTtlSeconds: number;            // Default TTL for cache entries
    throttleTtlSeconds: number;         // TTL for throttle state entries
  };

  // SMTP Validation Settings (applies to unauthenticated/free tier)
  smtp: {
    maxGlobalConcurrency: number;      // Max concurrent SMTP connections globally
    maxMxConcurrency: number;           // Max concurrent connections per MX host
    perDomainMinIntervalMs: number;     // Min time between checks to same domain
    softRetryLimit: number;             // How many retries on soft failures (4xx)
    initialRetryDelayMs: number;        // Initial delay before retry
    retryBackoffFactor: number;         // Exponential backoff multiplier
    connectTimeoutMs: number;           // TCP connection timeout
    overallTimeoutMs: number;           // Total operation timeout
    heloDomain: string;                 // Domain to use in HELO/EHLO
    mailFrom: string;                   // Email address for MAIL FROM
    
    // Per-phase timeouts for granular control
    bannerTimeoutMs: number;            // Timeout waiting for SMTP banner
    ehloTimeoutMs: number;              // Timeout for EHLO response
    mailTimeoutMs: number;              // Timeout for MAIL FROM response
    rcptTimeoutMs: number;              // Timeout for RCPT TO response
    
    // STARTTLS support
    requireTls: boolean;                // Require TLS upgrade (reject non-TLS)
    allowTlsDowngrade: boolean;         // Allow fallback to plaintext if TLS fails
    
    // MX probing strategy
    maxMxAttempts: number;              // Max MX hosts to try before giving up
    randomizeSamePriority: boolean;     // Randomize MX order within same priority
  };
}

/**
 * Tier-based rate limit profiles for future SaaS monetization
 * 
 * TODO (SaaS v2): Use these profiles in throttleState.ts based on RequestContext.tier
 * TODO (SaaS v2): Store in database for dynamic updates
 * TODO (SaaS v2): Add daily/monthly quota limits
 */
export interface RateLimitProfile {
  maxGlobalConcurrency: number;
  maxMxConcurrency: number;
  perDomainMinIntervalMs: number;
  maxBatchSize: number;
  dailyQuota: number;
}

export const RATE_LIMIT_PROFILES: Record<SubscriptionTier, RateLimitProfile> = {
  [SubscriptionTier.FREE]: {
    maxGlobalConcurrency: 5,          // Very conservative for free tier
    maxMxConcurrency: 1,               // One connection per MX
    perDomainMinIntervalMs: 3000,      // 3 seconds between requests
    maxBatchSize: 10,                  // Small batches only
    dailyQuota: 100,                   // 100 validations per day
  },
  [SubscriptionTier.STANDARD]: {
    maxGlobalConcurrency: 10,          // Default config values
    maxMxConcurrency: 2,
    perDomainMinIntervalMs: 2000,
    maxBatchSize: 500,
    dailyQuota: 10000,                 // ~333/day for 30-day month
  },
  [SubscriptionTier.PREMIUM]: {
    maxGlobalConcurrency: 20,          // More aggressive
    maxMxConcurrency: 3,
    perDomainMinIntervalMs: 1000,      // Faster
    maxBatchSize: 5000,
    dailyQuota: 100000,                // ~3,333/day for 30-day month
  },
  [SubscriptionTier.ENTERPRISE]: {
    maxGlobalConcurrency: 50,          // Custom infrastructure
    maxMxConcurrency: 5,
    perDomainMinIntervalMs: 500,       // Very fast
    maxBatchSize: 50000,
    dailyQuota: -1,                    // Unlimited
  },
};

/**
 * Parse environment variable as integer with validation
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @param min - Minimum allowed value (optional)
 * @param max - Maximum allowed value (optional)
 * @param required - Whether this variable is required
 * @throws Error if value is invalid or out of range
 */
function getEnvInt(
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number; required?: boolean } = {}
): number {
  const value = process.env[key];
  
  if (!value) {
    if (options.required) {
      throw new Error(`Required environment variable ${key} is not set`);
    }
    return defaultValue;
  }
  
  const parsed = parseInt(value, 10);
  
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key}="${value}" is not a valid integer`);
  }
  
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Environment variable ${key}=${parsed} is below minimum ${options.min}`);
  }
  
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Environment variable ${key}=${parsed} exceeds maximum ${options.max}`);
  }
  
  return parsed;
}

/**
 * Parse environment variable as float with validation
 */
function getEnvFloat(
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {}
): number {
  const value = process.env[key];
  
  if (!value) return defaultValue;
  
  const parsed = parseFloat(value);
  
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key}="${value}" is not a valid number`);
  }
  
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Environment variable ${key}=${parsed} is below minimum ${options.min}`);
  }
  
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Environment variable ${key}=${parsed} exceeds maximum ${options.max}`);
  }
  
  return parsed;
}

/**
 * Get environment variable as string with fallback default
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @param required - Whether this variable is required
 * @throws Error if required variable is not set
 */
function getEnvString(key: string, defaultValue: string, required: boolean = false): string {
  const value = process.env[key];
  
  if (!value && required) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  
  return value || defaultValue;
}

/**
 * Load and validate configuration from environment
 */
export const config: Config = {
  port: getEnvInt('PORT', 4000, { min: 1, max: 65535 }),
  nodeEnv: getEnvString('NODE_ENV', 'development'),

  redis: {
    enabled: getEnvString('REDIS_ENABLED', 'true') === 'true',
    url: getEnvString('REDIS_URL', 'redis://localhost:6379'),
    keyPrefix: getEnvString('REDIS_KEY_PREFIX', 'validr:'),
    cacheTtlSeconds: getEnvInt('REDIS_CACHE_TTL_SECONDS', 86400, { min: 60, max: 86400 }), // 24 hour default
    throttleTtlSeconds: getEnvInt('REDIS_THROTTLE_TTL_SECONDS', 300, { min: 10, max: 3600 }), // 5 min default
  },

  smtp: {
    maxGlobalConcurrency: getEnvInt('SMTP_MAX_GLOBAL_CONCURRENCY', 20, { min: 1, max: 100 }),
    maxMxConcurrency: getEnvInt('SMTP_MAX_MX_CONCURRENCY', 2, { min: 1, max: 10 }),
    perDomainMinIntervalMs: getEnvInt('SMTP_PER_DOMAIN_MIN_INTERVAL_MS', 2000, { min: 0 }),
    softRetryLimit: getEnvInt('SMTP_SOFT_RETRY_LIMIT', 1, { min: 0, max: 5 }),
    initialRetryDelayMs: getEnvInt('SMTP_INITIAL_RETRY_DELAY_MS', 2000, { min: 1000 }),
    retryBackoffFactor: getEnvFloat('SMTP_RETRY_BACKOFF_FACTOR', 2, { min: 1, max: 10 }),
    connectTimeoutMs: getEnvInt('SMTP_CONNECT_TIMEOUT_MS', 8000, { min: 1000, max: 60000 }),
    overallTimeoutMs: getEnvInt('SMTP_OVERALL_TIMEOUT_MS', 10000, { min: 5000, max: 120000 }),
    heloDomain: getEnvString('SMTP_HELO_DOMAIN', 'mail.localtest.candlebrain.app'),
    mailFrom: getEnvString('SMTP_MAIL_FROM', 'verifier@candlebrain.app'),
    
    // Per-phase timeouts for granular failure detection
    bannerTimeoutMs: getEnvInt('SMTP_BANNER_TIMEOUT_MS', 2000, { min: 1000, max: 30000 }),
    ehloTimeoutMs: getEnvInt('SMTP_EHLO_TIMEOUT_MS', 2000, { min: 1000, max: 30000 }),
    mailTimeoutMs: getEnvInt('SMTP_MAIL_TIMEOUT_MS', 2000, { min: 1000, max: 30000 }),
    rcptTimeoutMs: getEnvInt('SMTP_RCPT_TIMEOUT_MS', 3000, { min: 1000, max: 30000 }),
    
    // STARTTLS support
    requireTls: getEnvString('SMTP_REQUIRE_TLS', 'false') === 'true',
    allowTlsDowngrade: getEnvString('SMTP_ALLOW_TLS_DOWNGRADE', 'true') === 'true',
    
    // MX probing strategy
    maxMxAttempts: getEnvInt('SMTP_MAX_MX_ATTEMPTS', 2, { min: 1, max: 10 }),
    randomizeSamePriority: getEnvString('SMTP_RANDOMIZE_SAME_PRIORITY', 'true') === 'true',
  },
};

/**
 * Validate critical configuration values at startup
 * Throws if configuration is invalid
 */
export function validateConfig(): void {
  const errors: string[] = [];

  // Validate HELO domain format
  if (!config.smtp.heloDomain || !config.smtp.heloDomain.includes('.')) {
    errors.push(`SMTP_HELO_DOMAIN must be a valid domain (got: "${config.smtp.heloDomain}")`);
  }

  // Validate MAIL FROM email format
  if (!config.smtp.mailFrom || !config.smtp.mailFrom.includes('@')) {
    errors.push(`SMTP_MAIL_FROM must be a valid email address (got: "${config.smtp.mailFrom}")`);
  }

  // Validate timeout relationship
  if (config.smtp.overallTimeoutMs <= config.smtp.connectTimeoutMs) {
    errors.push(
      `SMTP_OVERALL_TIMEOUT_MS (${config.smtp.overallTimeoutMs}) must be greater than ` +
      `SMTP_CONNECT_TIMEOUT_MS (${config.smtp.connectTimeoutMs})`
    );
  }

  // Validate per-phase timeouts are reasonable
  const phaseTimeouts = [
    { name: 'SMTP_BANNER_TIMEOUT_MS', value: config.smtp.bannerTimeoutMs },
    { name: 'SMTP_EHLO_TIMEOUT_MS', value: config.smtp.ehloTimeoutMs },
    { name: 'SMTP_MAIL_TIMEOUT_MS', value: config.smtp.mailTimeoutMs },
    { name: 'SMTP_RCPT_TIMEOUT_MS', value: config.smtp.rcptTimeoutMs },
  ];

  for (const { name, value } of phaseTimeouts) {
    if (value <= 0) {
      errors.push(`${name} must be > 0 (got: ${value})`);
    }
    if (value >= config.smtp.overallTimeoutMs) {
      errors.push(
        `${name} (${value}ms) must be < SMTP_OVERALL_TIMEOUT_MS (${config.smtp.overallTimeoutMs}ms)`
      );
    }
  }

  // Warn if sum of phase timeouts exceeds overall timeout
  const sumPhaseTimeouts = phaseTimeouts.reduce((sum, { value }) => sum + value, 0);
  if (sumPhaseTimeouts > config.smtp.overallTimeoutMs) {
    logger.warn(
      `⚠️  Sum of phase timeouts (${sumPhaseTimeouts}ms) exceeds SMTP_OVERALL_TIMEOUT_MS ` +
      `(${config.smtp.overallTimeoutMs}ms). Overall timeout will take precedence.`
    );
  }

  // Validate TLS config logic
  if (config.smtp.requireTls && !config.smtp.allowTlsDowngrade) {
    logger.info('✅ Strict TLS mode enabled: will reject servers without STARTTLS');
  } else if (config.smtp.requireTls && config.smtp.allowTlsDowngrade) {
    logger.warn('⚠️  SMTP_REQUIRE_TLS=true but SMTP_ALLOW_TLS_DOWNGRADE=true. TLS failures will downgrade to plaintext.');
  }

  if (errors.length > 0) {
    throw new Error(`❌ Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}
