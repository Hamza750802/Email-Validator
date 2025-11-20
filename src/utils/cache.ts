/**
 * Cache abstraction layer for DNS/MX lookups and validation results.
 * 
 * IMPLEMENTATION: Dual-mode (Redis + In-memory fallback)
 * - When Redis is available: Uses distributed cache shared across all instances
 * - When Redis is unavailable: Falls back to in-memory cache (graceful degradation)
 * 
 * REDIS BENEFITS FOR PRODUCTION:
 *   ✅ Distributed caching across multiple instances/pods
 *   ✅ Persistence across restarts
 *   ✅ Shared state for horizontal scaling
 *   ✅ Automatic TTL expiration
 *   ✅ Atomic operations for race-free updates
 * 
 * CONFIGURATION:
 *   REDIS_ENABLED=true|false           # Enable/disable Redis
 *   REDIS_URL=redis://host:port        # Connection string
 *   REDIS_CACHE_TTL_SECONDS=3600       # Default cache TTL
 * 
 * @see https://redis.io/commands/set
 * @see https://github.com/luin/ioredis
 */

import { MxRecord } from '../types/email';
import { logger } from './logger';
import { getFromRedis, setInRedis, deleteFromRedis, redisClient } from './redis';
import { config } from '../config/env';

/**
 * Cache interface for pluggable implementations
 */
export interface ICache {
  /**
   * Retrieve value from cache by key
   * @returns Value if exists and not expired, null otherwise
   */
  get<T>(key: string): Promise<T | null>;
  
  /**
   * Store value in cache with TTL
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttlMs - Time to live in milliseconds
   */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  
  /**
   * Delete value from cache
   */
  delete(key: string): Promise<void>;
  
  /**
   * Clear all cached values (use with caution in production)
   */
  clear(): Promise<void>;
}

/**
 * Generic cache entry with TTL
 */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * In-memory cache implementation (fallback when Redis is unavailable)
 * 
 * LIMITATIONS (for public SaaS):
 *   ❌ Not shared across instances
 *   ❌ Lost on restart
 *   ❌ Memory-bound (no eviction policy beyond TTL)
 */
class InMemoryCache implements ICache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  
  /**
   * Generic get from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }
    
    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data as T;
  }
  
  /**
   * Generic set to cache with TTL
   */
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.cache.set(key, {
      data: value,
      expiresAt: Date.now() + ttlMs,
    });
  }
  
  /**
   * Delete from cache
   */
  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }
  
  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    this.cache.clear();
  }
  
  /**
   * Get cache statistics (useful for monitoring)
   * TODO: Export these metrics to /metrics endpoint
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
  
  /**
   * Clean up expired entries (called periodically)
   */
  cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Cache cleanup: ${cleaned} expired entries removed`);
    }
  }
}

/**
 * Domain-specific cache wrapper for MX records and validation results
 * Provides convenient methods while using generic cache underneath
 * 
 * This class abstracts the cache key naming and TTL defaults from the rest of the codebase
 */
class DomainCache {
  private cache: ICache;
  
  // Default TTLs - can be overridden per-call
  private readonly DEFAULT_MX_TTL_MS = 10 * 60 * 1000; // 10 minutes
  private readonly DEFAULT_VALIDATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
  
  constructor(cache: ICache) {
    this.cache = cache;
  }
  
  /**
   * Get MX records from cache
   */
  async getMxFromCache(domain: string): Promise<MxRecord[] | null> {
    const key = `mx:${domain.toLowerCase()}`;
    const records = await this.cache.get<MxRecord[]>(key);
    
    if (records) {
      logger.debug(`MX cache hit for domain: ${domain}`);
    } else {
      logger.debug(`MX cache miss for domain: ${domain}`);
    }
    
    return records;
  }
  
  /**
   * Store MX records in cache with TTL
   */
  async setMxInCache(domain: string, mxRecords: MxRecord[], ttlMs?: number): Promise<void> {
    const key = `mx:${domain.toLowerCase()}`;
    const ttl = ttlMs || this.DEFAULT_MX_TTL_MS;
    
    await this.cache.set(key, mxRecords, ttl);
    
    logger.debug(`MX records cached for domain: ${domain}`, {
      recordCount: mxRecords.length,
      ttlMs: ttl,
    });
  }
  
  /**
   * Get validation result from cache
   */
  async getValidationFromCache(email: string): Promise<any | null> {
    const key = `validation:${email.toLowerCase()}`;
    const result = await this.cache.get<any>(key);
    
    if (result) {
      logger.debug(`Validation cache hit for email: ${email}`);
    }
    
    return result;
  }
  
  /**
   * Store validation result in cache with TTL
   */
  async setValidationInCache(email: string, result: any, ttlMs?: number): Promise<void> {
    const key = `validation:${email.toLowerCase()}`;
    const ttl = ttlMs || this.DEFAULT_VALIDATION_TTL_MS;
    
    await this.cache.set(key, result, ttl);
    
    logger.debug(`Validation result cached for email: ${email}`, {
      ttlMs: ttl,
    });
  }
  
  /**
   * Clear all cache entries
   */
  async clearAll(): Promise<void> {
    await this.cache.clear();
    logger.info('All cache entries cleared');
  }
  
  /**
   * Get cache statistics
   * 
   * TODO (SaaS v2): Add hit/miss rates, memory usage
   */
  getStats(): { totalSize: number } {
    if (this.cache instanceof InMemoryCache) {
      const stats = (this.cache as InMemoryCache).getStats();
      return { totalSize: stats.size };
    }
    return { totalSize: 0 };
  }
  
  /**
   * Clean up expired entries
   */
  cleanupExpired(): void {
    if (this.cache instanceof InMemoryCache) {
      (this.cache as InMemoryCache).cleanupExpired();
    }
  }
}

/**
 * Redis-backed cache implementation (distributed cache for production)
 * Automatically falls back to in-memory if Redis is unavailable
 */
class RedisCache implements ICache {
  private fallback: InMemoryCache = new InMemoryCache();
  
  async get<T>(key: string): Promise<T | null> {
    // Try Redis first
    const redisValue = await getFromRedis<T>(key);
    if (redisValue !== null) {
      return redisValue;
    }
    
    // Fall back to in-memory cache
    return await this.fallback.get<T>(key);
  }
  
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    
    // Try Redis first
    const success = await setInRedis(key, value, ttlSeconds);
    
    // Always store in fallback cache (for when Redis goes down mid-session)
    await this.fallback.set(key, value, ttlMs);
    
    if (!success) {
      logger.warn('Redis SET failed, using in-memory cache only', { key });
    }
  }
  
  async delete(key: string): Promise<void> {
    await deleteFromRedis(key);
    await this.fallback.delete(key);
  }
  
  async clear(): Promise<void> {
    // Clear fallback cache
    await this.fallback.clear();
    
    // For Redis, we can't clear all keys without SCAN (expensive)
    // In production, you'd use FLUSHDB (dangerous) or key patterns
    logger.warn('Redis cache clear not implemented (would require SCAN or FLUSHDB)');
  }
}

/**
 * Factory function to get cache instance
 * Returns Redis-backed cache if enabled, otherwise in-memory
 */
function getCacheInstance(): ICache {
  if (config.redis.enabled) {
    // Trigger connection attempt (lazy initialization)
    const client = redisClient.getClient();
    
    if (client && redisClient.isConnected()) {
      logger.info('Using Redis-backed distributed cache');
      return new RedisCache();
    }
    
    logger.warn('Redis enabled but not connected, falling back to in-memory cache');
  }
  
  logger.info('Using in-memory cache (Redis disabled or unavailable)');
  return new InMemoryCache();
}

// Export singleton with hot-swap support via container pattern
const cacheContainer = {
  currentBackend: getCacheInstance(),
  wrapper: null as DomainCache | null
};

// Create the initial wrapper
cacheContainer.wrapper = new DomainCache(cacheContainer.currentBackend);

// Create proxy that delegates to the wrapper (which uses current backend)
const domainCacheProxy = new Proxy(cacheContainer.wrapper, {
  get(_target, prop) {
    // Get the current wrapper (recreated on hot-swap)
    const domainCache = cacheContainer.wrapper!;
    const value = (domainCache as any)[prop];
    
    // Bind methods to the wrapper instance
    if (typeof value === 'function') {
      return value.bind(domainCache);
    }
    return value;
  }
});

export const cache = domainCacheProxy;

// Hot-swap to Redis when connection becomes ready
if (config.redis.enabled && !redisClient.isConnected()) {
  const client = redisClient.getClient();
  if (client) {
    client.once('ready', () => {
      logger.info('Redis connected, upgrading cache backend from in-memory to distributed');
      cacheContainer.currentBackend = new RedisCache();
      // Recreate wrapper with new backend
      cacheContainer.wrapper = new DomainCache(cacheContainer.currentBackend);
      
      // Stop the in-memory cleanup interval since we're now using Redis
      if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        logger.debug('In-memory cache cleanup interval stopped (Redis now active)');
      }
    });
  }
}

// Run cleanup every 5 minutes for in-memory cache
let cleanupInterval: NodeJS.Timeout | null = null;

if (cacheContainer.currentBackend instanceof InMemoryCache) {
  cleanupInterval = setInterval(() => {
    // Only cleanup if current backend is still in-memory
    if (cacheContainer.currentBackend instanceof InMemoryCache) {
      cacheContainer.currentBackend.cleanupExpired();
    }
  }, 5 * 60 * 1000);
  
  // Unref so it doesn't keep process alive in tests
  if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }
}
