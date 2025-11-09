/**
 * Test to verify Proxy method binding works correctly
 * 
 * Run with: npm run build && node dist/test-proxy-binding.js
 * 
 * This test verifies that throttleState methods have correct 'this' binding
 * even when accessed through the Proxy.
 */

import { throttleState } from './src/utils/throttleState';

async function testProxyBinding() {
  console.log('=== Proxy Method Binding Test ===\n');
  
  try {
    // Test that acquireSlot can access 'this.mxStates' correctly
    console.log('[TEST 1] Calling throttleState.acquireSlot()...');
    
    await throttleState.acquireSlot('mx.test.com', {
      maxGlobalConcurrency: 10,
      maxMxConcurrency: 2,
      perDomainMinIntervalMs: 1000
    });
    
    console.log('  ✓ acquireSlot executed without errors');
    console.log('  ✓ Method has correct "this" binding');
    console.log();
    
    // Test that releaseSlot works
    console.log('[TEST 2] Calling throttleState.releaseSlot()...');
    
    throttleState.releaseSlot('mx.test.com');
    
    console.log('  ✓ releaseSlot executed without errors');
    console.log('  ✓ Method has correct "this" binding');
    console.log();
    
    // Test recordSuccess
    console.log('[TEST 3] Calling throttleState.recordSuccess()...');
    
    throttleState.recordSuccess('mx.test.com');
    
    console.log('  ✓ recordSuccess executed without errors');
    console.log('  ✓ Method has correct "this" binding');
    console.log();
    
    console.log('=== All Tests Passed ===');
    console.log('Proxy correctly binds methods to the underlying store instance.');
    
  } catch (error) {
    console.error('\n❌ Test Failed:', error);
    console.error('\nThis indicates the Proxy is NOT binding methods correctly.');
    console.error('Methods are executing with "this" pointing to the Proxy instead of the store.');
    process.exit(1);
  }
  
  process.exit(0);
}

testProxyBinding();
