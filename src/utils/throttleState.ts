/**
 * Adaptive throttling state management for SMTP validation.
 * 
 * IMPLEMENTATION: Dual-mode (Redis + In-memory fallback)
 * - When Redis is available: Uses distributed atomic operations shared across all instances
 * - When Redis is unavailable: Falls back to in-memory throttling (graceful degradation)
 * 
 * REDIS BENEFITS FOR PRODUCTION:
 *   ✅ Distributed state across multiple instances/pods
 *   ✅ Atomic operations prevent race conditions
 *   ✅ Persistent rate limiting across restarts
 *   ✅ True global concurrency limits
 *   ✅ Coordinated penalties across all instances
 * 
 * REDIS ARCHITECTURE:
 *   - throttle:{host}:concurrency (INT with EXPIRE) - Current slot count
 *   - throttle:{host}:penalty (TIMESTAMP with EXPIRE) - Penalty expiration
 *   - throttle:{host}:lastAttempt (TIMESTAMP) - Last connection time
 *   - throttle:{host}:state (JSON) - Full MxState for monitoring
 *   - throttle:global:concurrency (INT) - Global concurrency counter
 * 
 * @see https://redis.io/commands/incr
 * @see https://redis.io/commands/decr
 */

import { logger } from './logger';
import { redisClient, getFromRedis, setInRedis, decrementInRedis, acquireThrottleSlot } from './redis';
import { config as appConfig } from '../config/env';

/**
 * State tracking for each MX host
 */
export interface MxState {
  host: string;
  concurrency: number;              // Current active connections
  maxConcurrency: number;           // Current max allowed (adaptive)
  failures: number;                 // Recent failure count
  successCount: number;             // Recent success count
  penaltyUntil?: number;            // Timestamp when penalty expires (ms)
  lastAttemptAt?: number;           // Last connection attempt timestamp (ms)
  totalAttempts: number;            // Total connection attempts
  totalSuccesses: number;           // Total successful validations
}

/**
 * Throttle state store interface for pluggable implementations
 * 
 * TODO (SaaS v2): Implement RedisThrottleStore
 * TODO (SaaS v2): Add per-user/API-key rate limiting
 * TODO (SaaS v2): Add tier-based limits (free vs paid)
 */
export interface IThrottleStateStore {
  /**
   * Acquire a slot for SMTP connection
   * Waits if limits are exceeded or host is penalized
   */
  acquireSlot(mxHost: string, config: ThrottleConfig): Promise<void>;
  
  /**
   * Release a slot after SMTP connection completes
   */
  releaseSlot(mxHost: string): void;
  
  /**
   * Record a successful validation
   */
  recordSuccess(mxHost: string): void;
  
  /**
   * Record a failure and potentially apply penalty
   */
  recordFailure(mxHost: string, shouldPenalize: boolean): void;
  
  /**
   * Get current state for an MX host
   */
  getState(mxHost: string): MxState;
  
  /**
   * Clear all state (for testing)
   */
  clearAll(): void;
}

/**
 * Throttle configuration
 */
export interface ThrottleConfig {
  maxGlobalConcurrency: number;
  maxMxConcurrency: number;
  perDomainMinIntervalMs: number;
}

/**
 * Redis-backed throttle state implementation (distributed throttling for production)
 * Uses atomic Redis operations to coordinate across multiple service instances
 */
class RedisThrottleStore implements IThrottleStateStore {
  private fallback: InMemoryThrottleStore = new InMemoryThrottleStore();
  
  /**
   * Acquire a slot for SMTP connection
   * Uses Redis atomic operations for distributed coordination
   */
  async acquireSlot(mxHost: string, config: ThrottleConfig): Promise<void> {
    const client = redisClient.getClient();
    if (!client) {
      // Fall back to in-memory if Redis unavailable
      return await this.fallback.acquireSlot(mxHost, config);
    }
    
    const normalizedHost = mxHost.toLowerCase();
    const maxWaitTime = 60000;
    const startTime = Date.now();
    
    while (true) {
      const now = Date.now();
      
      if (now - startTime > maxWaitTime) {
        throw new Error(`Timeout waiting for slot to ${mxHost}`);
      }
      
      try {
        // Get max concurrency for this host
        const stateKey = `throttle:${normalizedHost}:state`;
        const state = await getFromRedis<MxState>(stateKey);
        const maxMxConcurrency = state?.maxConcurrency || Math.min(config.maxMxConcurrency, 2);
        
        // Atomic slot acquisition using Lua script (checks penalty, interval, and limits)
        const ttl = appConfig.redis.throttleTtlSeconds;
        const result = await acquireThrottleSlot(
          normalizedHost,
          config.maxGlobalConcurrency,
          maxMxConcurrency,
          ttl,
          now, // current timestamp
          config.perDomainMinIntervalMs // minimum interval
        );
        
        if (!result.acquired) {
          const reasonMsg = result.reason === 'penalty_active' ? 'penalized' :
                           result.reason === 'interval_not_met' ? 'interval not met' :
                           result.reason === 'global_limit_reached' ? 'global limit' :
                           result.reason === 'mx_limit_reached' ? 'mx limit' :
                           'unknown';
          
          logger.debug(`Slot acquisition rejected for ${mxHost}: ${reasonMsg}`, {
            global: `${result.globalConcurrency}/${config.maxGlobalConcurrency}`,
            mx: `${result.mxConcurrency}/${maxMxConcurrency}`,
            waitMs: result.waitMs
          });
          
          // Use the wait time from Lua script or default
          const waitTime = result.waitMs || 500;
          await this.sleep(Math.min(waitTime, 1000));
          continue;
        }
        
        // Slot acquired successfully - update state
        const newState: MxState = {
          host: normalizedHost,
          concurrency: result.mxConcurrency,
          maxConcurrency: maxMxConcurrency,
          failures: state?.failures || 0,
          successCount: state?.successCount || 0,
          totalAttempts: (state?.totalAttempts || 0) + 1,
          totalSuccesses: state?.totalSuccesses || 0,
          lastAttemptAt: now,
        };
        await setInRedis(stateKey, newState, ttl);
        
        logger.debug(`Slot acquired for ${mxHost}`, {
          mxConcurrency: result.mxConcurrency,
          globalConcurrency: result.globalConcurrency,
        });
        
        break;
      } catch (error) {
        logger.error('Redis throttle error, falling back to in-memory', error);
        return await this.fallback.acquireSlot(mxHost, config);
      }
    }
  }
  
  /**
   * Release a slot after SMTP connection completes
   */
  releaseSlot(mxHost: string): void {
    const client = redisClient.getClient();
    if (!client) {
      return this.fallback.releaseSlot(mxHost);
    }
    
    const normalizedHost = mxHost.toLowerCase();
    
    // Use fire-and-forget for release (non-blocking)
    (async () => {
      try {
        await decrementInRedis(`throttle:${normalizedHost}:concurrency`);
        await decrementInRedis(`throttle:global:concurrency`);
        
        // Update state
        const stateKey = `throttle:${normalizedHost}:state`;
        const state = await getFromRedis<MxState>(stateKey);
        if (state) {
          state.concurrency = Math.max(0, state.concurrency - 1);
          await setInRedis(stateKey, state, appConfig.redis.throttleTtlSeconds);
        }
        
        logger.debug(`Slot released for ${mxHost}`);
      } catch (error) {
        logger.error('Redis release error', error);
        this.fallback.releaseSlot(mxHost);
      }
    })();
  }
  
  /**
   * Record a successful validation
   */
  recordSuccess(mxHost: string): void {
    const client = redisClient.getClient();
    if (!client) {
      return this.fallback.recordSuccess(mxHost);
    }
    
    const normalizedHost = mxHost.toLowerCase();
    
    (async () => {
      try {
        const stateKey = `throttle:${normalizedHost}:state`;
        const state = await getFromRedis<MxState>(stateKey) || {
          host: normalizedHost,
          concurrency: 0,
          maxConcurrency: 2,
          failures: 0,
          successCount: 0,
          totalAttempts: 0,
          totalSuccesses: 0,
        };
        
        state.successCount++;
        state.totalSuccesses++;
        state.failures = Math.max(0, state.failures - 1);
        
        // Gradually increase max concurrency on sustained success
        if (state.successCount > 10 && state.maxConcurrency < 5) {
          state.maxConcurrency = Math.min(state.maxConcurrency + 1, 5);
          logger.info(`Increased max concurrency for ${mxHost} to ${state.maxConcurrency}`);
        }
        
        await setInRedis(stateKey, state, appConfig.redis.throttleTtlSeconds);
      } catch (error) {
        logger.error('Redis recordSuccess error', error);
      }
    })();
  }
  
  /**
   * Record a failure and potentially apply penalty
   */
  recordFailure(mxHost: string, shouldPenalize: boolean): void {
    const client = redisClient.getClient();
    if (!client) {
      return this.fallback.recordFailure(mxHost, shouldPenalize);
    }
    
    const normalizedHost = mxHost.toLowerCase();
    
    (async () => {
      try {
        const stateKey = `throttle:${normalizedHost}:state`;
        const state = await getFromRedis<MxState>(stateKey) || {
          host: normalizedHost,
          concurrency: 0,
          maxConcurrency: 2,
          failures: 0,
          successCount: 0,
          totalAttempts: 0,
          totalSuccesses: 0,
        };
        
        state.failures++;
        state.successCount = 0;
        
        if (shouldPenalize) {
          const penaltyMs = Math.min(300000, 5000 * Math.pow(2, state.failures));
          const penaltyUntil = Date.now() + penaltyMs;
          state.penaltyUntil = penaltyUntil;
          
          await setInRedis(`throttle:${normalizedHost}:penalty`, penaltyUntil, Math.ceil(penaltyMs / 1000));
          
          logger.warn(`Penalty applied to ${mxHost}`, {
            failures: state.failures,
            penaltyMs,
            penaltyUntil: new Date(penaltyUntil).toISOString(),
          });
        }
        
        // Decrease max concurrency on repeated failures
        if (state.failures > 3 && state.maxConcurrency > 1) {
          state.maxConcurrency = Math.max(1, state.maxConcurrency - 1);
          logger.info(`Decreased max concurrency for ${mxHost} to ${state.maxConcurrency}`);
        }
        
        await setInRedis(stateKey, state, appConfig.redis.throttleTtlSeconds);
      } catch (error) {
        logger.error('Redis recordFailure error', error);
      }
    })();
  }
  
  /**
   * Get current state for an MX host
   */
  getState(mxHost: string): MxState {
    const client = redisClient.getClient();
    if (!client) {
      return this.fallback.getState(mxHost);
    }
    
    const normalizedHost = mxHost.toLowerCase();
    
    // This method is sync, so we return a default and update async
    const defaultState: MxState = {
      host: normalizedHost,
      concurrency: 0,
      maxConcurrency: 2,
      failures: 0,
      successCount: 0,
      totalAttempts: 0,
      totalSuccesses: 0,
    };
    
    // Fire async fetch (result won't be used in this call, but will update cache)
    (async () => {
      try {
        const state = await getFromRedis<MxState>(`throttle:${normalizedHost}:state`);
        return state || defaultState;
      } catch (error) {
        return defaultState;
      }
    })();
    
    return defaultState;
  }
  
  /**
   * Clear all state (for testing)
   */
  clearAll(): void {
    this.fallback.clearAll();
    // Note: Can't easily clear all Redis keys without SCAN or FLUSHDB
    logger.warn('Redis throttle clear not fully implemented');
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * In-memory throttle state implementation (fallback when Redis unavailable)
 * 
 * LIMITATIONS:
 *   ❌ Not shared across instances
 *   ❌ Race conditions possible (no atomic operations)
 *   ❌ Lost on restart
 */
class InMemoryThrottleStore implements IThrottleStateStore {
  private mxStates: Map<string, MxState> = new Map();
  private globalConcurrency: number = 0;
  
  /**
   * Initialize or get MX state
   */
  private getOrCreateState(mxHost: string, maxMxConcurrency: number): MxState {
    const normalizedHost = mxHost.toLowerCase();
    
    if (!this.mxStates.has(normalizedHost)) {
      this.mxStates.set(normalizedHost, {
        host: normalizedHost,
        concurrency: 0,
        maxConcurrency: Math.min(maxMxConcurrency, 2), // Start conservative
        failures: 0,
        successCount: 0,
        totalAttempts: 0,
        totalSuccesses: 0,
      });
    }
    
    return this.mxStates.get(normalizedHost)!;
  }
  
  /**
   * Acquire a slot for SMTP connection to MX host.
   * Waits if limits are exceeded or host is penalized.
   */
  async acquireSlot(
    mxHost: string,
    config: ThrottleConfig
  ): Promise<void> {
    const state = this.getOrCreateState(mxHost, config.maxMxConcurrency);
    const maxWaitTime = 60000; // 60 seconds max wait
    const startTime = Date.now();
    
    while (true) {
      const now = Date.now();
      
      // Check if we've been waiting too long
      if (now - startTime > maxWaitTime) {
        throw new Error(`Timeout waiting for slot to ${mxHost}`);
      }
      
      // Check if host is penalized
      if (state.penaltyUntil && now < state.penaltyUntil) {
        const waitTime = Math.min(1000, state.penaltyUntil - now);
        logger.debug(`MX host ${mxHost} is penalized, waiting ${waitTime}ms`);
        await this.sleep(waitTime);
        continue;
      }
      
      // Check per-domain interval
      if (state.lastAttemptAt) {
        const timeSinceLastAttempt = now - state.lastAttemptAt;
        if (timeSinceLastAttempt < config.perDomainMinIntervalMs) {
          const waitTime = config.perDomainMinIntervalMs - timeSinceLastAttempt;
          logger.debug(`Respecting per-domain interval for ${mxHost}, waiting ${waitTime}ms`);
          await this.sleep(waitTime);
          continue;
        }
      }
      
      // Check global concurrency limit
      if (this.globalConcurrency >= config.maxGlobalConcurrency) {
        logger.debug(`Global concurrency limit reached (${this.globalConcurrency}/${config.maxGlobalConcurrency}), waiting...`);
        await this.sleep(500);
        continue;
      }
      
      // Check per-MX concurrency limit
      if (state.concurrency >= state.maxConcurrency) {
        logger.debug(`MX concurrency limit reached for ${mxHost} (${state.concurrency}/${state.maxConcurrency}), waiting...`);
        await this.sleep(500);
        continue;
      }
      
      // Acquire slot
      state.concurrency++;
      state.totalAttempts++;
      state.lastAttemptAt = now;
      this.globalConcurrency++;
      
      logger.debug(`Slot acquired for ${mxHost}`, {
        mxConcurrency: state.concurrency,
        globalConcurrency: this.globalConcurrency,
      });
      
      break;
    }
  }
  
  /**
   * Release a slot after SMTP connection completes
   */
  releaseSlot(mxHost: string): void {
    const state = this.mxStates.get(mxHost.toLowerCase());
    
    if (!state) {
      logger.warn(`Attempted to release slot for unknown MX host: ${mxHost}`);
      return;
    }
    
    state.concurrency = Math.max(0, state.concurrency - 1);
    this.globalConcurrency = Math.max(0, this.globalConcurrency - 1);
    
    logger.debug(`Slot released for ${mxHost}`, {
      mxConcurrency: state.concurrency,
      globalConcurrency: this.globalConcurrency,
    });
  }
  
  /**
   * Record a successful validation
   */
  recordSuccess(mxHost: string): void {
    const state = this.mxStates.get(mxHost.toLowerCase());
    if (!state) return;
    
    state.successCount++;
    state.totalSuccesses++;
    state.failures = Math.max(0, state.failures - 1); // Decay failures
    
    // Gradually increase max concurrency on sustained success
    if (state.successCount > 10 && state.maxConcurrency < 5) {
      state.maxConcurrency = Math.min(state.maxConcurrency + 1, 5);
      logger.info(`Increased max concurrency for ${mxHost} to ${state.maxConcurrency}`);
    }
  }
  
  /**
   * Record a failure and potentially apply penalty
   */
  recordFailure(mxHost: string, shouldPenalize: boolean): void {
    const state = this.mxStates.get(mxHost.toLowerCase());
    if (!state) return;
    
    state.failures++;
    state.successCount = 0; // Reset success counter
    
    if (shouldPenalize) {
      // Apply exponential backoff penalty
      const penaltyMs = Math.min(300000, 5000 * Math.pow(2, state.failures)); // Max 5 minutes
      state.penaltyUntil = Date.now() + penaltyMs;
      
      logger.warn(`Penalty applied to ${mxHost}`, {
        failures: state.failures,
        penaltyMs,
        penaltyUntil: new Date(state.penaltyUntil).toISOString(),
      });
    }
    
    // Decrease max concurrency on repeated failures
    if (state.failures > 3 && state.maxConcurrency > 1) {
      state.maxConcurrency = Math.max(1, state.maxConcurrency - 1);
      logger.info(`Decreased max concurrency for ${mxHost} to ${state.maxConcurrency}`);
    }
  }
  
  /**
   * Get current state for an MX host
   */
  getState(mxHost: string): MxState {
    return this.getOrCreateState(mxHost, 2);
  }
  
  /**
   * Clear all state (for testing)
   */
  clearAll(): void {
    this.mxStates.clear();
    this.globalConcurrency = 0;
  }
  
  /**
   * Get global statistics
   * 
   * TODO (SaaS v2): Export to /metrics endpoint
   */
  getStats(): {
    totalHosts: number;
    globalConcurrency: number;
    penalizedHosts: number;
  } {
    const now = Date.now();
    const penalizedHosts = Array.from(this.mxStates.values())
      .filter(s => s.penaltyUntil && now < s.penaltyUntil)
      .length;
    
    return {
      totalHosts: this.mxStates.size,
      globalConcurrency: this.globalConcurrency,
      penalizedHosts,
    };
  }
  
  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory function to get throttle store instance
 * Returns Redis-backed store if enabled, otherwise in-memory
 */
function getThrottleStore(): IThrottleStateStore {
  if (appConfig.redis.enabled) {
    // Trigger connection attempt (lazy initialization)
    const client = redisClient.getClient();
    
    if (client && redisClient.isConnected()) {
      logger.info('Using Redis-backed distributed throttling');
      return new RedisThrottleStore();
    }
    
    logger.warn('Redis enabled but not connected, falling back to in-memory throttling');
  }
  
  logger.info('Using in-memory throttling (Redis disabled or unavailable)');
  return new InMemoryThrottleStore();
}

// Export singleton instance with hot-swap support
// Use a mutable container so the Proxy can always access the current backend
const throttleStateContainer = {
  currentBackend: getThrottleStore()
};

export const throttleState = new Proxy(throttleStateContainer.currentBackend, {
  get(_target, prop) {
    // Always dereference the current backend from the container
    const backend = throttleStateContainer.currentBackend;
    const value = (backend as any)[prop];
    
    // Bind methods to the actual backend so 'this' works correctly
    if (typeof value === 'function') {
      return value.bind(backend);
    }
    return value;
  }
});

// Hot-swap to Redis when connection becomes ready
if (appConfig.redis.enabled && !redisClient.isConnected()) {
  const client = redisClient.getClient();
  if (client) {
    client.once('ready', () => {
      logger.info('Redis connected, upgrading throttle backend from in-memory to distributed');
      throttleStateContainer.currentBackend = new RedisThrottleStore();
    });
  }
}
