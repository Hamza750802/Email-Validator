#!/usr/bin/env node
/**
 * ValidR CLI - Email validation from file
 * 
 * A command-line tool for validating email addresses from a text file.
 * Part of the ValidR email validation service.
 * 
 * Usage:
 *   npx ts-node src/cli/validateFile.ts <file> [options]
 *   npm run validate-file <file> [options]
 * 
 * Options:
 *   --skip-smtp          Skip SMTP validation (faster)
 *   --out <file>         Write full JSON results to file
 *   --help, -h           Show help
 */

import * as fs from 'fs';
import * as path from 'path';
import { validateEmail } from '../services/emailValidationService';
import { EmailValidationResult } from '../types/email';
import { logger } from '../utils/logger';

/**
 * CLI configuration parsed from arguments
 */
interface CliConfig {
  inputFile: string;
  skipSmtp: boolean;
  outputFile?: string;
  showHelp: boolean;
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): CliConfig {
  const config: CliConfig = {
    inputFile: '',
    skipSmtp: false,
    showHelp: false,
  };

  // Check for help flag
  if (args.includes('--help') || args.includes('-h')) {
    config.showHelp = true;
    return config;
  }

  // Find input file (first non-flag argument)
  const nonFlagArgs = args.filter(arg => !arg.startsWith('--'));
  if (nonFlagArgs.length > 0) {
    config.inputFile = nonFlagArgs[0];
  }

  // Parse flags
  config.skipSmtp = args.includes('--skip-smtp');

  // Parse --out flag
  const outIndex = args.indexOf('--out');
  if (outIndex !== -1 && args[outIndex + 1]) {
    config.outputFile = args[outIndex + 1];
  }

  return config;
}

/**
 * Display help message
 */
function showHelp(): void {
  console.log(`
ValidR Email Validator CLI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

USAGE
  npx ts-node src/cli/validateFile.ts <file> [options]
  npm run validate-file <file> [options]

ARGUMENTS
  <file>                Path to text file with emails (one per line)

OPTIONS
  --skip-smtp           Skip SMTP validation for faster results
  --out <file>          Write full JSON results to specified file
  --help, -h            Show this help message

EXAMPLES
  # Validate emails with SMTP check
  npm run validate-file emails.txt

  # Validate without SMTP (faster)
  npm run validate-file emails.txt --skip-smtp

  # Save detailed JSON output
  npm run validate-file emails.txt --skip-smtp --out results.json

OUTPUT
  Displays a table with validation results including:
  - Email address
  - Syntax validity
  - Domain MX records
  - SMTP status
  - Disposable domain flag
  - Role account flag
  - Overall score (0.0 - 1.0)

For more information, visit: https://github.com/yourusername/validr
`);
}

/**
 * Read emails from file
 */
function readEmailsFromFile(filePath: string): string[] {
  try {
    const absolutePath = path.resolve(filePath);
    
    if (!fs.existsSync(absolutePath)) {
      console.error(`❌ Error: File not found: ${filePath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const emails = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#')); // Filter empty lines and comments

    if (emails.length === 0) {
      console.error(`❌ Error: No emails found in file: ${filePath}`);
      process.exit(1);
    }

    return emails;
  } catch (error: any) {
    console.error(`❌ Error reading file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Write results to JSON file
 */
function writeJsonOutput(filePath: string, results: EmailValidationResult[]): void {
  try {
    const absolutePath = path.resolve(filePath);
    const json = JSON.stringify(results, null, 2);
    fs.writeFileSync(absolutePath, json, 'utf-8');
    console.log(`\n✓ Full results written to: ${absolutePath}`);
  } catch (error: any) {
    console.error(`❌ Error writing output file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Format a table row value
 */
function formatValue(value: any, maxLength: number = 20): string {
  const str = String(value);
  if (str.length > maxLength) {
    return str.substring(0, maxLength - 3) + '...';
  }
  return str.padEnd(maxLength);
}

/**
 * Format boolean as Yes/No
 */
function formatBoolean(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/**
 * Print results as a formatted table
 */
function printResultsTable(results: EmailValidationResult[]): void {
  console.log('\n' + '='.repeat(120));
  console.log('VALIDATION RESULTS');
  console.log('='.repeat(120));

  // Table header
  const headers = [
    'Email'.padEnd(30),
    'Syntax'.padEnd(8),
    'Has MX'.padEnd(8),
    'SMTP'.padEnd(15),
    'Disposable'.padEnd(12),
    'Role'.padEnd(6),
    'Score'.padEnd(6),
  ];
  console.log(headers.join(' │ '));
  console.log('─'.repeat(120));

  // Table rows
  for (const result of results) {
    const row = [
      formatValue(result.email, 30),
      formatValue(formatBoolean(result.syntaxValid), 8),
      formatValue(formatBoolean(result.domainHasMx), 8),
      formatValue(result.smtpStatus, 15),
      formatValue(formatBoolean(result.disposable), 12),
      formatValue(formatBoolean(result.roleAccount), 6),
      formatValue(result.score.toFixed(2), 6),
    ];
    console.log(row.join(' │ '));
  }

  console.log('='.repeat(120));

  // Summary statistics
  const validSyntax = results.filter(r => r.syntaxValid).length;
  const hasMx = results.filter(r => r.domainHasMx).length;
  const disposable = results.filter(r => r.disposable).length;
  const roleAccounts = results.filter(r => r.roleAccount).length;
  const avgScore = (results.reduce((sum, r) => sum + r.score, 0) / results.length).toFixed(2);

  console.log(`\nSUMMARY`);
  console.log(`  Total emails:        ${results.length}`);
  console.log(`  Valid syntax:        ${validSyntax} (${((validSyntax / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Has MX records:      ${hasMx} (${((hasMx / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Disposable domains:  ${disposable} (${((disposable / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Role accounts:       ${roleAccounts} (${((roleAccounts / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Average score:       ${avgScore}`);
}

/**
 * Main CLI function
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = parseArgs(args);

  // Show help if requested or no arguments
  if (config.showHelp || args.length === 0) {
    showHelp();
    process.exit(0);
  }

  // Validate input file argument
  if (!config.inputFile) {
    console.error('❌ Error: Missing required argument: <file>');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  console.log('ValidR Email Validator');
  console.log('━'.repeat(50));
  console.log(`Input file:  ${config.inputFile}`);
  console.log(`SMTP check:  ${config.skipSmtp ? 'Disabled (--skip-smtp)' : 'Enabled'}`);
  if (config.outputFile) {
    console.log(`JSON output: ${config.outputFile}`);
  }
  console.log('━'.repeat(50));

  // Read emails from file
  const emails = readEmailsFromFile(config.inputFile);
  console.log(`\n📧 Found ${emails.length} email(s) to validate\n`);

  // Validate emails
  const results: EmailValidationResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    process.stdout.write(`Validating ${i + 1}/${emails.length}: ${email.padEnd(40)} ... `);

    try {
      const result = await validateEmail(email, { skipSmtp: config.skipSmtp });
      results.push(result);
      
      // Show quick status
      const statusIcon = result.score >= 0.8 ? '✓' : result.score >= 0.5 ? '⚠' : '✗';
      process.stdout.write(`${statusIcon} Score: ${result.score.toFixed(2)}\n`);
    } catch (error: any) {
      process.stdout.write(`✗ Error: ${error.message}\n`);
      logger.error(`Error validating ${email}:`, error);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n⏱  Validation completed in ${(duration / 1000).toFixed(2)}s (avg: ${(duration / emails.length).toFixed(0)}ms per email)`);

  // Print results table
  printResultsTable(results);

  // Write JSON output if requested
  if (config.outputFile) {
    writeJsonOutput(config.outputFile, results);
  }

  console.log('\n✨ Done!\n');
}

// Run CLI
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    logger.error('CLI fatal error:', error);
    process.exit(1);
  });
}

export { main };
