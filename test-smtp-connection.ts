/**
 * Test SMTP Connection Diagnostic
 * 
 * This script tests if your environment can make outbound SMTP connections
 * on port 25 to common mail servers.
 */

import * as net from 'net';
import * as dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

interface SmtpTestResult {
  host: string;
  port: number;
  success: boolean;
  banner?: string;
  error?: string;
  timeMs: number;
}

async function testSmtpConnection(host: string, port: number = 25, timeout: number = 10000): Promise<SmtpTestResult> {
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let banner: string = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      resolve({
        host,
        port,
        success: false,
        error: 'Connection timeout',
        timeMs: Date.now() - startTime,
      });
    }, timeout);

    socket.on('connect', () => {
      console.log(`✓ Connected to ${host}:${port}`);
    });

    socket.on('data', (data) => {
      banner = data.toString();
      console.log(`✓ Received banner from ${host}: ${banner.trim()}`);
      
      clearTimeout(timer);
      socket.destroy();
      
      resolve({
        host,
        port,
        success: true,
        banner: banner.trim(),
        timeMs: Date.now() - startTime,
      });
    });

    socket.on('error', (error) => {
      if (!timedOut) {
        clearTimeout(timer);
        resolve({
          host,
          port,
          success: false,
          error: error.message,
          timeMs: Date.now() - startTime,
        });
      }
    });

    socket.on('close', () => {
      if (!timedOut && !banner) {
        clearTimeout(timer);
        resolve({
          host,
          port,
          success: false,
          error: 'Connection closed without banner',
          timeMs: Date.now() - startTime,
        });
      }
    });

    console.log(`→ Attempting connection to ${host}:${port}...`);
    socket.connect(port, host);
  });
}

async function runDiagnostics() {
  console.log('='.repeat(70));
  console.log('SMTP CONNECTION DIAGNOSTIC');
  console.log('='.repeat(70));
  console.log('');

  // Test common mail servers
  const testDomains = [
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
  ];

  const results: SmtpTestResult[] = [];

  for (const domain of testDomains) {
    console.log(`\nTesting ${domain}...`);
    console.log('-'.repeat(70));
    
    try {
      // Get MX records
      const mxRecords = await resolveMx(domain);
      if (!mxRecords || mxRecords.length === 0) {
        console.log(`✗ No MX records found for ${domain}`);
        continue;
      }

      // Sort by priority
      const sortedMx = mxRecords.sort((a, b) => a.priority - b.priority);
      console.log(`Found ${mxRecords.length} MX records for ${domain}:`);
      sortedMx.forEach((mx) => {
        console.log(`  - ${mx.exchange} (priority ${mx.priority})`);
      });

      // Test first MX
      const firstMx = sortedMx[0];
      console.log(`\nTesting connection to ${firstMx.exchange}:25...`);
      
      const result = await testSmtpConnection(firstMx.exchange, 25, 10000);
      results.push(result);

      if (result.success) {
        console.log(`✓ SUCCESS - Connection established in ${result.timeMs}ms`);
      } else {
        console.log(`✗ FAILED - ${result.error} (${result.timeMs}ms)`);
      }

    } catch (error: any) {
      console.log(`✗ Error: ${error.message}`);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  
  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  console.log(`\nTotal tests: ${totalCount}`);
  console.log(`Successful: ${successCount} (${Math.round(successCount / totalCount * 100)}%)`);
  console.log(`Failed: ${totalCount - successCount}`);

  if (successCount === 0) {
    console.log('\n⚠️  CRITICAL ISSUE DETECTED');
    console.log('=' .repeat(70));
    console.log('Your environment CANNOT make outbound SMTP connections on port 25.');
    console.log('');
    console.log('Common causes:');
    console.log('  1. Residential ISP blocking port 25');
    console.log('  2. Cloud provider restrictions (no reverse DNS)');
    console.log('  3. Corporate/network firewall blocking SMTP');
    console.log('  4. Windows Firewall or antivirus blocking connections');
    console.log('');
    console.log('Solutions:');
    console.log('  • Deploy to a VPS/cloud server with SMTP access');
    console.log('  • Set up reverse DNS (PTR record) for your IP');
    console.log('  • Use an SMTP validation API service');
    console.log('  • Check firewall settings and allow port 25 outbound');
    console.log('');
  } else if (successCount < totalCount) {
    console.log('\n⚠️  PARTIAL SUCCESS');
    console.log('Some SMTP connections work, but not all. This may indicate:');
    console.log('  • Rate limiting');
    console.log('  • IP reputation issues');
    console.log('  • Intermittent connectivity problems');
  } else {
    console.log('\n✓ ALL TESTS PASSED');
    console.log('Your environment can make SMTP connections successfully!');
  }

  console.log('');
}

// Run diagnostics
runDiagnostics().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
