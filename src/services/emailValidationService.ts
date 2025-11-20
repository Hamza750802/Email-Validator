/**
 * Email validation orchestration service.
 * Coordinates all validation layers and computes overall validation scores.
 * This is the main service that external callers interact with.
 * 
 * FUTURE SAAS FEATURES:
 *   - Use RequestContext for tier-based rate limiting
 *   - Track usage per user/API key
 *   - Apply quota limits (daily/monthly)
 *   - Audit log all validations
 */

import { createHash } from 'crypto';
import { EmailValidationResult, ValidationReasonCode } from '../types/email';
import { RequestContext } from '../types/context';
import { validateSyntax } from '../validators/syntaxValidator';
import { validateMx } from '../validators/dnsValidator';
import { validateDisposable } from '../validators/disposableValidator';
import { validateRole } from '../validators/roleValidator';
import { validateSmtp } from '../validators/smtpValidator';
import { calculateScore } from '../validators/scoreCalculator';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

/**
 * Hash email for privacy-safe logging (PII protection)
 * Returns first 8 chars of SHA256 hash for log correlation
 */
function hashEmailForLogging(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 8);
}

export interface ValidationOptions {
  /**
   * Skip SMTP validation (useful for faster checks or when SMTP is unavailable)
   * Default: false
   */
  skipSmtp?: boolean;
  
  /**
   * Cache TTL for DNS lookups in milliseconds
   * Default: 10 minutes
   */
  cacheTtlMs?: number;
  
  /**
   * Request context for multi-tenant SaaS (optional, for future use)
   * 
   * TODO (SaaS v2): Use context.tier to apply rate limit profiles
   * TODO (SaaS v2): Use context.userId for usage tracking
   * TODO (SaaS v2): Use context.requestId for distributed tracing
   */
  context?: RequestContext;
}

/**
 * Validate an email address through all validation layers.
 * 
 * This is the primary validation function that orchestrates:
 * 1. Syntax validation (RFC 5321/5322)
 * 2. DNS/MX record lookup
 * 3. Disposable domain detection
 * 4. Role account detection
 * 5. SMTP mailbox verification (optional)
 * 
 * @param email - Email address to validate
 * @param options - Validation options
 * @returns Complete validation result with scoring
 * 
 * FUTURE: Apply tier-based limits before validation
 * ```typescript
 * if (options.context) {
 *   await checkRateLimit(options.context);
 *   await checkQuota(options.context);
 * }
 * ```
 */
export async function validateEmail(
  email: string,
  options: ValidationOptions = {}
): Promise<EmailValidationResult> {
  const startTime = Date.now();
  const allReasonCodes: ValidationReasonCode[] = [];
  const emailHash = hashEmailForLogging(email);
  
  logger.info(`Starting validation`, { emailHash, domain: email.split('@')[1] || 'unknown' });
  
  // Step 1: Syntax validation
  logger.debug('Step 1: Syntax validation');
  const syntaxResult = validateSyntax(email);
  allReasonCodes.push(...syntaxResult.reasonCodes);
  
  // If syntax is invalid, return early with minimal result
  if (!syntaxResult.syntaxValid) {
    logger.info(`Validation failed: Invalid syntax`, { emailHash });
    
    const score = calculateScore({
      syntaxValid: false,
      domainHasMx: false,
      disposable: false,
      roleAccount: false,
      smtpStatus: 'not_checked',
    });
    
    const result: EmailValidationResult = {
      email,
      localPart: syntaxResult.localPart,
      domain: syntaxResult.domain,
      syntaxValid: false,
      domainHasMx: false,
      disposable: false,
      roleAccount: false,
      smtpStatus: 'not_checked',
      score,
      reasonCodes: allReasonCodes,
      validatedAt: new Date(),
      validationTimeMs: Date.now() - startTime,
    };
    
    // Track metrics even for invalid syntax
    metrics.incrementValidations();
    metrics.recordSmtpValidation('not_checked');
    
    return result;
  }
  
  const { localPart, domain } = syntaxResult;
  
  // Step 2: DNS/MX validation
  logger.debug('Step 2: DNS/MX validation');
  const mxResult = await validateMx(domain, options.cacheTtlMs);
  allReasonCodes.push(...mxResult.reasonCodes);
  
  // Step 3: Disposable domain check
  logger.debug('Step 3: Disposable domain check');
  const disposableResult = validateDisposable(domain);
  allReasonCodes.push(...disposableResult.reasonCodes);
  
  // Step 4: Role account check
  logger.debug('Step 4: Role account check');
  const roleResult = validateRole(localPart);
  allReasonCodes.push(...roleResult.reasonCodes);
  
  // Step 5: SMTP validation (if not skipped and has MX records)
  let smtpStatus: EmailValidationResult['smtpStatus'] = 'not_checked';
  let rawSmtpResponse: string | undefined;
  
  if (!options.skipSmtp && mxResult.domainHasMx) {
    logger.debug('Step 5: SMTP validation');
    const smtpResult = await validateSmtp(email, domain);
    smtpStatus = smtpResult.smtpStatus;
    rawSmtpResponse = smtpResult.rawSmtpResponse;
    allReasonCodes.push(...smtpResult.reasonCodes);
  } else if (options.skipSmtp) {
    logger.debug('Step 5: SMTP validation skipped (skipSmtp=true)');
  } else {
    logger.debug('Step 5: SMTP validation skipped (no MX records)');
  }
  
  // Step 6: Calculate score using scoreCalculator
  const score = calculateScore({
    syntaxValid: syntaxResult.syntaxValid,
    domainHasMx: mxResult.domainHasMx,
    disposable: disposableResult.disposable,
    roleAccount: roleResult.roleAccount,
    smtpStatus,
  });
  
  const result: EmailValidationResult = {
    email,
    localPart,
    domain,
    syntaxValid: syntaxResult.syntaxValid,
    domainHasMx: mxResult.domainHasMx,
    disposable: disposableResult.disposable,
    roleAccount: roleResult.roleAccount,
    smtpStatus,
    catchAll: smtpStatus === 'catch_all' || allReasonCodes.includes('smtp_catch_all') ? true : undefined,
    greylisted: allReasonCodes.includes('smtp_greylisted') ? true : undefined,
    rawSmtpResponse,
    score,
    reasonCodes: allReasonCodes,
    validatedAt: new Date(),
    validationTimeMs: Date.now() - startTime,
  };
  
  // Track metrics
  metrics.incrementValidations();
  metrics.recordSmtpValidation(smtpStatus);
  
  logger.info(`Validation complete`, {
    emailHash,
    domain: result.domain,
    score,
    syntaxValid: result.syntaxValid,
    domainHasMx: result.domainHasMx,
    disposable: result.disposable,
    roleAccount: result.roleAccount,
    smtpStatus: result.smtpStatus,
    timeMs: result.validationTimeMs,
  });
  
  return result;
}

/**
 * Legacy alias for backward compatibility.
 * @deprecated Use validateEmail instead
 */
export async function validateEmailBasic(
  email: string,
  options: ValidationOptions = {}
): Promise<EmailValidationResult> {
  return validateEmail(email, options);
}

/**
 * Batch validate multiple email addresses.
 * Processes emails concurrently with a configurable concurrency limit.
 * 
 * @param emails - Array of email addresses to validate
 * @param options - Validation options
 * @param concurrency - Maximum number of concurrent validations (default: 20)
 * @returns Array of validation results in the same order as input
 */
export async function validateEmailBatch(
  emails: string[],
  options: ValidationOptions = {},
  concurrency: number = 20
): Promise<EmailValidationResult[]> {
  logger.info(`Starting batch validation for ${emails.length} emails`);
  
  const results: EmailValidationResult[] = [];
  
  // Process in chunks to respect concurrency limit
  for (let i = 0; i < emails.length; i += concurrency) {
    const chunk = emails.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(email => validateEmail(email, options))
    );
    results.push(...chunkResults);
    
    logger.debug(`Batch progress: ${results.length}/${emails.length} emails validated`);
  }
  
  logger.info(`Batch validation complete: ${results.length} emails processed`);
  
  return results;
}
