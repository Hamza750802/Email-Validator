/**
 * Manual test to verify Redis hot-swap functionality
 * 
 * Run with: npm run build && node dist/test-redis-hotswap.js
 * 
 * Prerequisites:
 *   1. Start Redis: docker run -d -p 6379:6379 redis:alpine
 *   2. Set REDIS_ENABLED=true in environment
 */

import { config } from './src/config/env';
import { cache } from './src/utils/cache';
import { throttleState } from './src/utils/throttleState';
import { redisClient } from './src/utils/redis';

async function testRedisHotSwap() {
  console.log('=== Redis Hot-Swap Test ===\n');
  
  console.log('Configuration:');
  console.log(`  REDIS_ENABLED: ${config.redis.enabled}`);
  console.log(`  REDIS_URL: ${config.redis.url}`);
  console.log();
  
  // Test 1: Check initial state
  console.log('[TEST 1] Initial State');
  const client = redisClient.getClient();
  console.log(`  Redis client created: ${!!client}`);
  console.log(`  Redis connected: ${redisClient.isConnected()}`);
  console.log();
  
  // Test 2: Wait for connection
  console.log('[TEST 2] Waiting for Redis connection (5 seconds)...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log(`  Redis connected after wait: ${redisClient.isConnected()}`);
  console.log();
  
  // Test 3: Test cache operations
  console.log('[TEST 3] Testing cache operations');
  try {
    // Set a test MX record
    await cache.setMxInCache('example.com', [
      { exchange: 'mx.example.com', priority: 10 }
    ]);
    console.log('  ✓ Cache setMxInCache successful');
    
    // Get the value back
    const retrieved = await cache.getMxFromCache('example.com');
    console.log(`  ✓ Cache getMxFromCache successful: ${JSON.stringify(retrieved)}`);
    
    if (retrieved && retrieved.length === 1 && retrieved[0].exchange === 'mx.example.com') {
      console.log('  ✓ Value matches!');
    } else {
      console.log('  ✗ Value mismatch!');
    }
  } catch (error) {
    console.log(`  ✗ Cache error: ${error}`);
  }
  console.log();
  
  // Test 4: Test throttle operations
  console.log('[TEST 4] Testing throttle operations');
  try {
    await throttleState.acquireSlot('mx.example.com', {
      maxGlobalConcurrency: 10,
      maxMxConcurrency: 2,
      perDomainMinIntervalMs: 1000
    });
    console.log('  ✓ Throttle acquireSlot successful');
    
    throttleState.releaseSlot('mx.example.com');
    console.log('  ✓ Throttle releaseSlot successful');
  } catch (error) {
    console.log(`  ✗ Throttle error: ${error}`);
  }
  console.log();
  
  // Test 5: Verify backend type
  console.log('[TEST 5] Backend verification');
  if (redisClient.isConnected()) {
    console.log('  ✓ Redis is connected - distributed mode should be active');
    console.log('  ✓ Cache and throttle should be using Redis backend');
  } else {
    console.log('  ℹ Redis not connected - using in-memory fallback');
    console.log('  ℹ This is expected if Redis is not running');
  }
  console.log();
  
  // Cleanup
  await redisClient.disconnect();
  console.log('=== Test Complete ===');
  process.exit(0);
}

testRedisHotSwap().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
