/**
 * Redis client singleton with graceful degradation.
 * 
 * Handles connection pooling, automatic reconnection, and fallback to in-memory
 * when Redis is unavailable. All cache and throttle operations go through this
 * abstraction to enable distributed state across multiple service instances.
 * 
 * Architecture:
 * - Single connection pool shared across the application
 * - Automatic reconnection with exponential backoff
 * - Graceful degradation: errors logged but don't crash the service
 * - Health monitoring for /health endpoint
 */

import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from './logger';

class RedisClient {
  private client: Redis | null = null;
  private connectionAttempted = false;
  private lastError: Error | null = null;
  private connected = false;

  /**
   * Get the Redis client instance. Creates connection on first access.
   * Returns null if Redis is disabled or connection failed (graceful degradation).
   */
  getClient(): Redis | null {
    if (!config.redis.enabled) {
      return null;
    }

    if (!this.connectionAttempted) {
      this.connect();
    }

    return this.client;
  }

  /**
   * Check if Redis is currently connected and available
   */
  isConnected(): boolean {
    return this.connected && this.client !== null && this.client.status === 'ready';
  }

  /**
   * Get last connection error (for health checks)
   */
  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Initialize Redis connection with error handling
   */
  private connect(): void {
    this.connectionAttempted = true;

    try {
      this.client = new Redis(config.redis.url, {
        // Connection pool settings
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        enableOfflineQueue: false, // Fail fast if Redis is down

        // Reconnection strategy
        retryStrategy: (times: number) => {
          if (times > 10) {
            logger.error('Redis max reconnection attempts reached, giving up', { attempts: times });
            return null; // Stop retrying
          }
          const delay = Math.min(times * 100, 3000); // Max 3 second delay
          logger.warn('Redis reconnecting...', { attempt: times, delayMs: delay });
          return delay;
        },

        // Timeouts
        connectTimeout: 5000,
        commandTimeout: 3000,

        // Key prefix for namespace isolation
        keyPrefix: config.redis.keyPrefix,
      });

      // Event handlers
      this.client.on('connect', () => {
        logger.info('Redis connection established', { url: this.sanitizeUrl(config.redis.url) });
      });

      this.client.on('ready', () => {
        this.connected = true;
        this.lastError = null;
        logger.info('Redis client ready', { url: this.sanitizeUrl(config.redis.url) });
      });

      this.client.on('error', (error: Error) => {
        this.lastError = error;
        this.connected = false;
        logger.error('Redis connection error (service will degrade gracefully)', error);
      });

      this.client.on('close', () => {
        this.connected = false;
        logger.warn('Redis connection closed');
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis attempting to reconnect...');
      });

    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to initialize Redis client (falling back to in-memory)', this.lastError);
      this.client = null;
    }
  }

  /**
   * Gracefully close Redis connection (for shutdown)
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
        logger.info('Redis client disconnected');
      } catch (error) {
        logger.error('Error disconnecting Redis client', error);
      } finally {
        this.client = null;
        this.connected = false;
      }
    }
  }

  /**
   * Remove credentials from URL for logging
   */
  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = '***';
      }
      return parsed.toString();
    } catch {
      return url.replace(/:([^@]+)@/, ':***@'); // Simple regex fallback
    }
  }

  /**
   * Ping Redis to verify connectivity
   */
  async ping(): Promise<boolean> {
    const client = this.getClient();
    if (!client) {
      return false;
    }

    try {
      const result = await client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis ping failed', error);
      return false;
    }
  }
}

// Export singleton instance
export const redisClient = new RedisClient();

/**
 * Helper: Get a value from Redis with automatic JSON parsing
 */
export async function getFromRedis<T>(key: string): Promise<T | null> {
  const client = redisClient.getClient();
  if (!client) {
    return null;
  }

  try {
    const value = await client.get(key);
    if (!value) {
      return null;
    }
    return JSON.parse(value) as T;
  } catch (error) {
    logger.error('Redis GET failed', { key, error });
    return null;
  }
}

/**
 * Helper: Set a value in Redis with automatic JSON serialization and TTL
 */
export async function setInRedis(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
  const client = redisClient.getClient();
  if (!client) {
    return false;
  }

  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await client.set(key, serialized);
    }
    return true;
  } catch (error) {
    logger.error('Redis SET failed', { key, error });
    return false;
  }
}

/**
 * Helper: Delete a key from Redis
 */
export async function deleteFromRedis(key: string): Promise<boolean> {
  const client = redisClient.getClient();
  if (!client) {
    return false;
  }

  try {
    await client.del(key);
    return true;
  } catch (error) {
    logger.error('Redis DEL failed', { key, error });
    return false;
  }
}

/**
 * Helper: Increment a counter in Redis (atomic operation)
 */
export async function incrementInRedis(key: string, ttlSeconds?: number): Promise<number | null> {
  const client = redisClient.getClient();
  if (!client) {
    return null;
  }

  try {
    const value = await client.incr(key);
    if (ttlSeconds && value === 1) {
      // Only set TTL on first increment (when counter was created)
      await client.expire(key, ttlSeconds);
    }
    return value;
  } catch (error) {
    logger.error('Redis INCR failed', { key, error });
    return null;
  }
}

/**
 * Helper: Decrement a counter in Redis (atomic operation)
 */
export async function decrementInRedis(key: string): Promise<number | null> {
  const client = redisClient.getClient();
  if (!client) {
    return null;
  }

  try {
    return await client.decr(key);
  } catch (error) {
    logger.error('Redis DECR failed', { key, error });
    return null;
  }
}

/**
 * Atomically acquire a throttle slot using Lua script
 * Checks penalty, interval, and concurrency limits in one atomic operation
 * Returns status and all relevant state
 */
export async function acquireThrottleSlot(
  mxHost: string,
  maxGlobalConcurrency: number,
  maxMxConcurrency: number,
  ttlSeconds: number,
  currentTime: number,
  minIntervalMs: number
): Promise<{
  acquired: boolean;
  reason?: string;
  globalConcurrency: number;
  mxConcurrency: number;
  waitMs?: number;
}> {
  const client = redisClient.getClient();
  if (!client) {
    return { acquired: false, reason: 'redis_unavailable', globalConcurrency: 0, mxConcurrency: 0 };
  }

  // Lua script for atomic slot acquisition with all gate checks
  // Returns: [acquired (0/1), reason_code, globalCount, mxCount, waitMs]
  // Reason codes: 0=success, 1=penalty, 2=interval, 3=global_limit, 4=mx_limit
  const luaScript = `
    local globalKey = KEYS[1]
    local mxKey = KEYS[2]
    local penaltyKey = KEYS[3]
    local lastAttemptKey = KEYS[4]
    
    local maxGlobal = tonumber(ARGV[1])
    local maxMx = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])
    local now = tonumber(ARGV[4])
    local minInterval = tonumber(ARGV[5])
    
    -- Check penalty first
    local penaltyUntil = tonumber(redis.call('GET', penaltyKey)) or 0
    if now < penaltyUntil then
      local waitMs = penaltyUntil - now
      return {0, 1, 0, 0, waitMs}  -- rejected: penalty active
    end
    
    -- Check per-domain interval
    local lastAttempt = tonumber(redis.call('GET', lastAttemptKey)) or 0
    if lastAttempt > 0 then
      local timeSince = now - lastAttempt
      if timeSince < minInterval then
        local waitMs = minInterval - timeSince
        return {0, 2, 0, 0, waitMs}  -- rejected: too soon
      end
    end
    
    -- Check concurrency limits
    local globalCount = tonumber(redis.call('GET', globalKey)) or 0
    local mxCount = tonumber(redis.call('GET', mxKey)) or 0
    
    if globalCount >= maxGlobal then
      return {0, 3, globalCount, mxCount, 500}  -- rejected: global limit
    end
    
    if mxCount >= maxMx then
      return {0, 4, globalCount, mxCount, 500}  -- rejected: mx limit
    end
    
    -- All checks passed - acquire slot
    globalCount = redis.call('INCR', globalKey)
    mxCount = redis.call('INCR', mxKey)
    
    -- Update last attempt time
    redis.call('SET', lastAttemptKey, now, 'EX', ttl)
    
    -- Set TTL on counters if first increment
    if globalCount == 1 then
      redis.call('EXPIRE', globalKey, ttl)
    end
    if mxCount == 1 then
      redis.call('EXPIRE', mxKey, ttl)
    end
    
    return {1, 0, globalCount, mxCount, 0}  -- success
  `;

  try {
    const globalKey = 'throttle:global:concurrency';
    const mxKey = `throttle:${mxHost}:concurrency`;
    const penaltyKey = `throttle:${mxHost}:penalty`;
    const lastAttemptKey = `throttle:${mxHost}:lastAttempt`;
    
    const result = await client.eval(
      luaScript,
      4, // number of keys
      globalKey,
      mxKey,
      penaltyKey,
      lastAttemptKey,
      maxGlobalConcurrency.toString(),
      maxMxConcurrency.toString(),
      ttlSeconds.toString(),
      currentTime.toString(),
      minIntervalMs.toString()
    ) as number[];

    const [acquired, reasonCode, globalCount, mxCount, waitMs] = result;
    
    const reasonMap: Record<number, string> = {
      0: 'success',
      1: 'penalty_active',
      2: 'interval_not_met',
      3: 'global_limit_reached',
      4: 'mx_limit_reached'
    };

    return {
      acquired: acquired === 1,
      reason: reasonMap[reasonCode] || 'unknown',
      globalConcurrency: globalCount,
      mxConcurrency: mxCount,
      waitMs: waitMs > 0 ? waitMs : undefined
    };
  } catch (error) {
    logger.error('Error in acquireThrottleSlot Lua script', error);
    return { acquired: false, reason: 'script_error', globalConcurrency: 0, mxConcurrency: 0 };
  }
}
