/**
 * Quick manual test of the validation service
 * Run with: ts-node src/test-manual.ts
 */

import { validateEmailBasic } from './services/emailValidationService';

async function test() {
  console.log('=== ValidR Manual Test ===\n');

  const testEmails = [
    'user@gmail.com',
    'admin@example.com',
    'test@mailinator.com',
    'invalid-email',
    'user@nonexistent-domain-12345.com',
  ];

  console.log('Testing WITHOUT SMTP validation (skipSmtp: true):\n');
  for (const email of testEmails) {
    console.log(`Testing: ${email}`);
    try {
      const result = await validateEmailBasic(email, { skipSmtp: true });
      console.log(`  ✓ Score: ${result.score}`);
      console.log(`  ✓ Valid syntax: ${result.syntaxValid}`);
      console.log(`  ✓ Has MX: ${result.domainHasMx}`);
      console.log(`  ✓ Disposable: ${result.disposable}`);
      console.log(`  ✓ Role: ${result.roleAccount}`);
      console.log(`  ✓ SMTP Status: ${result.smtpStatus}`);
      console.log(`  ✓ Time: ${result.validationTimeMs}ms`);
    } catch (error: any) {
      console.log(`  ✗ Error: ${error.message}`);
    }
    console.log('');
  }

  console.log('\n=== Test Complete ===');
  process.exit(0);
}

test();
