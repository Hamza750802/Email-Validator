/**
 * SMTP validator with polite handshake and adaptive throttling.
 * 
 * This module performs actual SMTP verification by connecting to mail servers
 * and checking if they accept the recipient address. Uses raw TCP sockets for
 * maximum control and minimal dependencies.
 * 
 * Design principles:
 * - Polite: Respects rate limits, proper SMTP etiquette
 * - Safe: Adaptive throttling prevents blacklisting
 * - Accurate: Interprets all SMTP codes correctly
 * 
 * WARNING: Performs real network connections. Use sparingly and responsibly.
 * For production SaaS: Implement distributed rate limiting with Redis.
 */

import { Socket } from 'net';
import { SmtpStatus, ValidationReasonCode, MxRecord } from '../types/email';
import { validateMx } from './dnsValidator';
import { throttleState } from '../utils/throttleState';
import { logger } from '../utils/logger';
import { config } from '../config/env';

/**
 * SMTP validation configuration
 */
export interface SmtpValidationConfig {
  maxGlobalConcurrency: number;
  maxMxConcurrency: number;
  perDomainMinIntervalMs: number;
  softRetryLimit: number;
  initialRetryDelayMs: number;
  retryBackoffFactor: number;
  connectTimeoutMs: number;
  overallTimeoutMs: number;
  heloDomain: string;
  mailFrom: string;
  
  // Per-phase timeouts
  bannerTimeoutMs: number;
  ehloTimeoutMs: number;
  mailTimeoutMs: number;
  rcptTimeoutMs: number;
  
  // STARTTLS support
  requireTls: boolean;
  allowTlsDowngrade: boolean;
  
  // MX probing strategy
  maxMxAttempts: number;
  randomizeSamePriority: boolean;
}

/**
 * SMTP validation result
 */
export interface SmtpValidationResult {
  smtpStatus: SmtpStatus;
  reasonCodes: ValidationReasonCode[];
  rawSmtpResponse?: string;
}

/**
 * Get default SMTP configuration from env
 */
export function getDefaultSmtpConfig(): SmtpValidationConfig {
  return {
    maxGlobalConcurrency: config.smtp.maxGlobalConcurrency,
    maxMxConcurrency: config.smtp.maxMxConcurrency,
    perDomainMinIntervalMs: config.smtp.perDomainMinIntervalMs,
    softRetryLimit: config.smtp.softRetryLimit,
    initialRetryDelayMs: config.smtp.initialRetryDelayMs,
    retryBackoffFactor: config.smtp.retryBackoffFactor,
    connectTimeoutMs: config.smtp.connectTimeoutMs,
    overallTimeoutMs: config.smtp.overallTimeoutMs,
    heloDomain: config.smtp.heloDomain,
    mailFrom: config.smtp.mailFrom,
    
    // Per-phase timeouts
    bannerTimeoutMs: config.smtp.bannerTimeoutMs,
    ehloTimeoutMs: config.smtp.ehloTimeoutMs,
    mailTimeoutMs: config.smtp.mailTimeoutMs,
    rcptTimeoutMs: config.smtp.rcptTimeoutMs,
    
    // STARTTLS support
    requireTls: config.smtp.requireTls,
    allowTlsDowngrade: config.smtp.allowTlsDowngrade,
    
    // MX probing strategy
    maxMxAttempts: config.smtp.maxMxAttempts,
    randomizeSamePriority: config.smtp.randomizeSamePriority,
  };
}

/**
 * Validate email via SMTP handshake.
 * Performs polite verification with adaptive throttling and retry logic.
 * 
 * @param email - Full email address to validate
 * @param domain - Domain part (for MX lookup)
 * @param smtpConfig - SMTP configuration (optional, uses defaults from env)
 * @returns SMTP validation result with status and reason codes
 */
export async function validateSmtp(
  email: string,
  domain: string,
  smtpConfig?: SmtpValidationConfig
): Promise<SmtpValidationResult> {
  const cfg = smtpConfig || getDefaultSmtpConfig();
  const startTime = Date.now();
  
  logger.info(`Starting SMTP validation for ${email}`);
  
  try {
    // Step 1: Get MX records (from cache or DNS)
    const mxResult = await validateMx(domain);
    
    if (!mxResult.domainHasMx || !mxResult.mxRecords || mxResult.mxRecords.length === 0) {
      logger.warn(`No MX records for domain ${domain}`);
      return {
        smtpStatus: 'invalid',
        reasonCodes: ['no_mx_records', 'smtp_invalid'],
      };
    }
    
    // Step 2: Sort and optionally randomize MX hosts
    const sortedMx = mxResult.mxRecords.sort((a, b) => a.priority - b.priority);
    
    // Randomize MX hosts within same priority (reduces load concentration)
    if (cfg.randomizeSamePriority) {
      let i = 0;
      while (i < sortedMx.length) {
        const currentPriority = sortedMx[i].priority;
        let j = i;
        
        // Find all MX with same priority
        while (j < sortedMx.length && sortedMx[j].priority === currentPriority) {
          j++;
        }
        
        // Shuffle this group using Fisher-Yates
        for (let k = j - 1; k > i; k--) {
          const rand = i + Math.floor(Math.random() * (k - i + 1));
          [sortedMx[k], sortedMx[rand]] = [sortedMx[rand], sortedMx[k]];
        }
        
        i = j;
      }
    }
    
    // Limit number of MX attempts
    const mxToTry = sortedMx.slice(0, cfg.maxMxAttempts);
    logger.debug(`Will try ${mxToTry.length} of ${sortedMx.length} MX hosts (max ${cfg.maxMxAttempts})`);
    
    // Step 3: Check if domain is catch-all (test until definitive result)
    let catchAllResult: 'yes' | 'no' | 'inconclusive' = 'inconclusive';
    
    for (const mx of mxToTry) {
      if (!mx.exchange || mx.exchange.length === 0) continue;
      
      catchAllResult = await detectCatchAll(mx.exchange, domain, cfg);
      
      if (catchAllResult === 'yes') {
        logger.info(`Domain ${domain} is catch-all (tested via ${mx.exchange})`);
        return {
          smtpStatus: 'catch_all',
          reasonCodes: ['smtp_catch_all'],
          rawSmtpResponse: 'Domain accepts all email addresses (catch-all)',
        };
      }
      
      // Only break on definitive results (yes or no)
      // Continue to next MX if inconclusive (greylisting, timeout, etc.)
      if (catchAllResult === 'no') {
        logger.debug(`Not catch-all: ${domain} (tested via ${mx.exchange})`);
        break;  // Definitive: not catch-all
      }
      
      logger.debug(`Catch-all test inconclusive on ${mx.exchange}, trying next MX...`);
    }
    
    // Step 4: Validate specific email address
    const failureReasons: Record<string, string> = {};
    
    for (const mx of mxToTry) {
      // Skip empty exchanges
      if (!mx.exchange || mx.exchange.length === 0) {
        continue;
      }
      
      try {
        const result = await validateSmtpWithRetry(email, mx, cfg);
        
        // If we got a definitive result (valid or invalid), return it
        if (result.smtpStatus === 'valid' || result.smtpStatus === 'invalid' || result.smtpStatus === 'catch_all') {
          logger.info(`SMTP validation complete for ${email}: ${result.smtpStatus}`, {
            mx: mx.exchange,
            timeMs: Date.now() - startTime,
          });
          return result;
        }
        
        // Record failure reason for debugging
        failureReasons[mx.exchange] = result.reasonCodes.join(', ');
        
        // Otherwise, try next MX host
        logger.debug(`MX ${mx.exchange} returned ${result.smtpStatus}, trying next...`);
      } catch (error: any) {
        failureReasons[mx.exchange] = error.message;
        logger.warn(`Error validating with MX ${mx.exchange}:`, error.message);
        // Continue to next MX
      }
    }
    
    // All MX hosts failed or returned unknown
    logger.warn(`All MX hosts failed or returned unknown for ${email}`, { failureReasons });
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_mx_all_failed', 'smtp_connection_failed'],
      rawSmtpResponse: `All ${mxToTry.length} MX hosts failed: ${Object.entries(failureReasons).map(([mx, reason]) => `${mx}=${reason}`).join('; ')}`,
    };
    
  } catch (error: any) {
    logger.error(`SMTP validation error for ${email}:`, error);
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_connection_failed'],
      rawSmtpResponse: error.message,
    };
  }
}

/**
 * Validate SMTP with retry logic for soft failures
 */
async function validateSmtpWithRetry(
  email: string,
  mx: MxRecord,
  cfg: SmtpValidationConfig
): Promise<SmtpValidationResult> {
  let lastResult: SmtpValidationResult | null = null;
  let attempt = 0;
  
  while (attempt <= cfg.softRetryLimit) {
    try {
      const result = await validateSmtpSingle(email, mx.exchange, cfg);
      
      // Success or hard failure - return immediately
      if (result.smtpStatus === 'valid' || 
          result.smtpStatus === 'invalid' || 
          result.smtpStatus === 'catch_all') {
        return result;
      }
      
      // Soft failure - maybe retry
      lastResult = result;
      
      if (result.smtpStatus === 'temporarily_unavailable' && attempt < cfg.softRetryLimit) {
        const delay = cfg.initialRetryDelayMs * Math.pow(cfg.retryBackoffFactor, attempt);
        logger.info(`Soft failure, retrying in ${delay}ms (attempt ${attempt + 1}/${cfg.softRetryLimit})`);
        await sleep(delay);
        attempt++;
        continue;
      }
      
      // No more retries
      break;
      
    } catch (error: any) {
      logger.warn(`SMTP attempt ${attempt + 1} failed:`, error.message);
      
      if (attempt < cfg.softRetryLimit) {
        const delay = cfg.initialRetryDelayMs * Math.pow(cfg.retryBackoffFactor, attempt);
        await sleep(delay);
        attempt++;
        continue;
      }
      
      // Max retries exceeded
      return {
        smtpStatus: 'unknown',
        reasonCodes: ['smtp_connection_failed', 'smtp_timeout'],
        rawSmtpResponse: error.message,
      };
    }
  }
  
  // Return last result
  if (lastResult) {
    lastResult.reasonCodes.push('smtp_soft_fails_exceeded');
    return lastResult;
  }
  
  return {
    smtpStatus: 'unknown',
    reasonCodes: ['smtp_connection_failed'],
  };
}

/**
 * Perform single SMTP validation attempt using raw TCP socket
 */
async function validateSmtpSingle(
  email: string,
  mxHost: string,
  cfg: SmtpValidationConfig
): Promise<SmtpValidationResult> {
  // Acquire throttle slot (waits if needed)
  await throttleState.acquireSlot(mxHost, {
    maxGlobalConcurrency: cfg.maxGlobalConcurrency,
    maxMxConcurrency: cfg.maxMxConcurrency,
    perDomainMinIntervalMs: cfg.perDomainMinIntervalMs,
  });
  
  let socket: Socket | null = null;
  
  try {
    logger.debug(`Connecting to MX ${mxHost} for ${email}`);
    
    // Create TCP socket connection
    socket = new Socket();
    
    // Perform SMTP handshake with timeout
    const result = await Promise.race([
      performSmtpHandshake(socket, mxHost, email, cfg),
      timeoutPromise(cfg.overallTimeoutMs),
    ]);
    
    // Record success
    throttleState.recordSuccess(mxHost);
    
    return result;
    
  } catch (error: any) {
    // Detect if this is a hard block
    const isHardBlock = isHardBlockError(error);
    throttleState.recordFailure(mxHost, isHardBlock);
    
    logger.warn(`SMTP handshake failed for ${mxHost}:`, {
      error: error.message,
      isHardBlock,
    });
    
    // Map error to result
    return mapErrorToResult(error);
    
  } finally {
    // Always release slot and close socket
    throttleState.releaseSlot(mxHost);
    
    if (socket) {
      socket.destroy();
    }
  }
}

/**
 * Perform SMTP handshake: Connect -> EHLO -> (STARTTLS) -> MAIL FROM -> RCPT TO -> QUIT
 * Enhanced with per-phase timeouts and STARTTLS support
 */
async function performSmtpHandshake(
  socket: Socket,
  mxHost: string,
  email: string,
  cfg: SmtpValidationConfig
): Promise<SmtpValidationResult> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let step = 0; // 0=banner, 1=ehlo, 2=starttls(optional), 3=mail, 4=rcpt
    let rawResponse = '';
    let ehloCapabilities: string[] = []; // Store EHLO capabilities
    let currentTimeout: NodeJS.Timeout | null = null;
    
    // Set per-phase timeout
    const setPhaseTimeout = (phase: string, timeoutMs: number) => {
      if (currentTimeout) clearTimeout(currentTimeout);
      currentTimeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`${phase}_timeout`));
      }, timeoutMs);
    };
    
    // Handle incoming data
    socket.on('data', (data) => {
      buffer += data.toString();
      
      // Check if we have a complete response (ends with \r\n)
      if (!buffer.includes('\r\n')) {
        return;
      }
      
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (!line) continue;
        
        rawResponse += line + '\n';
        const code = extractSmtpCode(line);
        
        logger.debug(`SMTP [${mxHost}] <<< ${line}`);
        
        // Handle multi-line responses (code followed by -)
        if (line[3] === '-') {
          // Store EHLO capabilities from multi-line response
          if (step === 1) {
            const capability = line.substring(4).trim().toUpperCase();
            if (capability) {
              ehloCapabilities.push(capability);
            }
          }
          continue; // Wait for final line
        }
        
        // Also parse final line capability (some servers list on "250 <capability>")
        if (step === 1 && code === 250 && line.length > 4) {
          const finalCapability = line.substring(4).trim().toUpperCase();
          if (finalCapability && !ehloCapabilities.includes(finalCapability)) {
            ehloCapabilities.push(finalCapability);
          }
        }
        
        // Clear timeout when we receive response
        if (currentTimeout) {
          clearTimeout(currentTimeout);
          currentTimeout = null;
        }
        
        // Process based on current step
        if (step === 0) {
          // Server greeting (220)
          if (code !== 220) {
            return reject(new Error(`Unexpected greeting: ${line}`));
          }
          // Send EHLO
          setPhaseTimeout('ehlo', cfg.ehloTimeoutMs);
          const ehlo = `EHLO ${cfg.heloDomain}\r\n`;
          logger.debug(`SMTP [${mxHost}] >>> ${ehlo.trim()}`);
          socket.write(ehlo);
          step = 1;
          
        } else if (step === 1) {
          // EHLO response (250 = success, 530 = TLS required)
          if (code === 530) {
            // Server requires STARTTLS before EHLO
            const quit = 'QUIT\r\n';
            socket.write(quit);
            return resolve({
              smtpStatus: 'unknown',
              reasonCodes: ['smtp_tls_required'],
              rawSmtpResponse: `530 Must issue STARTTLS first: ${line}`,
            });
          }
          
          if (code !== 250) {
            return reject(new Error(`EHLO rejected: ${line}`));
          }
          
          // Check for STARTTLS capability
          const hasStartTls = ehloCapabilities.includes('STARTTLS');
          logger.debug(`SMTP [${mxHost}] EHLO capabilities: ${ehloCapabilities.join(', ')}`);
          
          // Enforce REQUIRE_TLS: if server doesn't support STARTTLS, reject
          if (cfg.requireTls && !hasStartTls) {
            const quit = 'QUIT\r\n';
            socket.write(quit);
            logger.warn(`SMTP [${mxHost}] TLS required but server doesn't support STARTTLS`);
            return resolve({
              smtpStatus: 'unknown',
              reasonCodes: ['smtp_tls_required'],
              rawSmtpResponse: `TLS required but server lacks STARTTLS capability. Capabilities: ${ehloCapabilities.join(', ')}`,
            });
          }
          
          if (hasStartTls) {
            // TODO: Implement STARTTLS upgrade using tls.connect()
            // For now, log and continue without TLS (unless requireTls=true, handled above)
            logger.debug(`SMTP [${mxHost}] STARTTLS available but upgrade not implemented yet`);
            
            if (cfg.requireTls) {
              // This should not happen (already handled above), but safety check
              const quit = 'QUIT\r\n';
              socket.write(quit);
              return resolve({
                smtpStatus: 'unknown',
                reasonCodes: ['smtp_tls_required'],
                rawSmtpResponse: 'TLS required but STARTTLS upgrade not yet implemented',
              });
            }
          }
          
          // Send MAIL FROM
          setPhaseTimeout('mail', cfg.mailTimeoutMs);
          const mailFrom = `MAIL FROM:<${cfg.mailFrom}>\r\n`;
          logger.debug(`SMTP [${mxHost}] >>> ${mailFrom.trim()}`);
          socket.write(mailFrom);
          step = 3; // Skip STARTTLS step for now
          
        } else if (step === 3) {
          // MAIL FROM response (250)
          // Check if TLS is required (530 = Must issue STARTTLS first)
          if (code === 530) {
            const quit = 'QUIT\r\n';
            socket.write(quit);
            return resolve({
              smtpStatus: 'unknown',
              reasonCodes: ['smtp_tls_required'],
              rawSmtpResponse: line,
            });
          }
          if (code !== 250) {
            return reject(new Error(`MAIL FROM rejected: ${line}`));
          }
          // Send RCPT TO (the actual validation)
          setPhaseTimeout('rcpt', cfg.rcptTimeoutMs);
          const rcptTo = `RCPT TO:<${email}>\r\n`;
          logger.debug(`SMTP [${mxHost}] >>> ${rcptTo.trim()}`);
          socket.write(rcptTo);
          step = 4;
          
        } else if (step === 4) {
          // RCPT TO response - this determines if email is valid
          const quit = 'QUIT\r\n';
          socket.write(quit);
          
          const result = interpretSmtpCode(code, line, rawResponse);
          return resolve(result);
        }
      }
    });
    
    socket.on('error', (err) => {
      if (currentTimeout) clearTimeout(currentTimeout);
      reject(err);
    });
    
    socket.on('timeout', () => {
      if (currentTimeout) clearTimeout(currentTimeout);
      reject(new Error('Socket timeout'));
    });
    
    socket.on('end', () => {
      if (currentTimeout) clearTimeout(currentTimeout);
      if (step < 4) {
        reject(new Error('Connection closed prematurely'));
      }
    });
    
    // Connect to MX host and wait for banner
    setPhaseTimeout('banner', cfg.bannerTimeoutMs);
    socket.connect(25, mxHost);
    
    // Enable TCP keep-alive to prevent idle disconnects during long RCPT waits
    socket.setKeepAlive(true, 5000);
  });
}

/**
 * Extract SMTP status code from response
 */
function extractSmtpCode(response: string): number {
  const match = response.match(/^(\d{3})/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Interpret SMTP status code and message
 */
function interpretSmtpCode(
  code: number,
  message: string,
  rawResponse: string
): SmtpValidationResult {
  const lowerMessage = message.toLowerCase();
  
  // 2xx - Success
  if (code >= 200 && code < 300) {
    // Check for catch-all indicators
    if (lowerMessage.includes('catch-all') || 
        lowerMessage.includes('accept all') ||
        lowerMessage.includes('accepts all')) {
      return {
        smtpStatus: 'catch_all',
        reasonCodes: ['smtp_catch_all'],
        rawSmtpResponse: rawResponse,
      };
    }
    
    return {
      smtpStatus: 'valid',
      reasonCodes: ['smtp_valid'],
      rawSmtpResponse: rawResponse,
    };
  }
  
  // 4xx - Temporary failure (soft bounce)
  if (code >= 400 && code < 500) {
    const reasonCodes: ValidationReasonCode[] = ['smtp_temporarily_unavailable'];
    
    // Greylisting indicators
    if (code === 450 || code === 451 || code === 452 || 
        lowerMessage.includes('greylist') || 
        lowerMessage.includes('try again') ||
        lowerMessage.includes('retry')) {
      reasonCodes.push('smtp_greylisted');
    }
    
    // Rate limiting indicators
    if (code === 421 || code === 452 || 
        lowerMessage.includes('rate') || 
        lowerMessage.includes('throttle') ||
        lowerMessage.includes('too many')) {
      reasonCodes.push('smtp_rate_limited');
    }
    
    return {
      smtpStatus: 'temporarily_unavailable',
      reasonCodes,
      rawSmtpResponse: rawResponse,
    };
  }
  
  // 5xx - Permanent failure (hard bounce)
  if (code >= 500 && code < 600) {
    return {
      smtpStatus: 'invalid',
      reasonCodes: ['smtp_invalid'],
      rawSmtpResponse: rawResponse,
    };
  }
  
  // Unknown code
  return {
    smtpStatus: 'unknown',
    reasonCodes: ['smtp_connection_failed'],
    rawSmtpResponse: rawResponse,
  };
}

/**
 * Detect if error indicates a hard block (blacklist, policy violation, etc.)
 */
function isHardBlockError(error: any): boolean {
  const message = (error.message || '').toLowerCase();
  
  const blockIndicators = [
    'blacklist',
    'blocked',
    'banned',
    'policy',
    'abuse',
    'spam',
    'reputation',
    'rbl',
    'dnsbl',
  ];
  
  return blockIndicators.some(indicator => message.includes(indicator));
}

/**
 * Map connection error to SMTP result
 */
function mapErrorToResult(error: any): SmtpValidationResult {
  const message = error.message || '';
  const code = extractSmtpCode(message);
  
  if (code > 0) {
    return interpretSmtpCode(code, message, message);
  }
  
  // Enhanced error taxonomy for better analytics
  
  // Per-phase timeouts
  if (message.includes('banner_timeout')) {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_banner_timeout', 'smtp_timeout'],
      rawSmtpResponse: 'Timeout waiting for SMTP banner',
    };
  }
  
  if (message.includes('ehlo_timeout')) {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_ehlo_timeout', 'smtp_timeout'],
      rawSmtpResponse: 'Timeout during EHLO handshake',
    };
  }
  
  if (message.includes('mail_timeout')) {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_mail_timeout', 'smtp_timeout'],
      rawSmtpResponse: 'Timeout during MAIL FROM',
    };
  }
  
  if (message.includes('rcpt_timeout')) {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_rcpt_timeout', 'smtp_timeout'],
      rawSmtpResponse: 'Timeout during RCPT TO',
    };
  }
  
  // Connection errors with specific codes
  if (message.includes('ECONNREFUSED') || error.code === 'ECONNREFUSED') {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_conn_refused', 'smtp_connection_failed'],
      rawSmtpResponse: 'Connection refused (port 25 closed/filtered)',
    };
  }
  
  if (message.includes('ENETUNREACH') || error.code === 'ENETUNREACH' ||
      message.includes('EHOSTUNREACH') || error.code === 'EHOSTUNREACH') {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_network_unreachable', 'smtp_connection_failed'],
      rawSmtpResponse: 'Network or host unreachable (routing issue)',
    };
  }
  
  if (message.includes('ECONNRESET') || error.code === 'ECONNRESET') {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_conn_reset', 'smtp_connection_failed'],
      rawSmtpResponse: 'Connection reset by peer (possibly IP-blocked)',
    };
  }
  
  // Generic timeout
  if (message.includes('timeout') || message.includes('ETIMEDOUT') || error.code === 'ETIMEDOUT') {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_timeout'],
      rawSmtpResponse: message || 'Operation timed out',
    };
  }
  
  // Fallback for unknown errors
  return {
    smtpStatus: 'unknown',
    reasonCodes: ['smtp_connection_failed'],
    rawSmtpResponse: message || 'Unknown SMTP error',
  };
}

/**
 * Detect if a domain is a catch-all server by testing a random email address.
 * Catch-all servers accept ANY email address, which makes individual validation unreliable.
 * 
 * @param mxHost - Mail server to test
 * @param domain - Domain being validated
 * @param cfg - SMTP configuration
 * @returns true if domain is catch-all, false otherwise
 */
/**
 * Detect if a domain is a catch-all server by testing a random email address.
 * Catch-all servers accept ANY email address, which makes individual validation unreliable.
 * 
 * @returns 'yes' if catch-all, 'no' if not catch-all, 'inconclusive' if can't determine
 */
async function detectCatchAll(
  mxHost: string,
  domain: string,
  cfg: SmtpValidationConfig
): Promise<'yes' | 'no' | 'inconclusive'> {
  try {
    // Generate a guaranteed-random email that shouldn't exist
    const randomLocal = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const randomEmail = `${randomLocal}@${domain}`;
    
    logger.debug(`Testing catch-all with random email: ${randomEmail}`);
    
    const result = await validateSmtpSingle(randomEmail, mxHost, cfg);
    
    // If the random email is accepted, the domain is catch-all
    if (result.smtpStatus === 'valid') {
      logger.info(`Catch-all detected for domain ${domain}`);
      return 'yes';
    }
    
    // If explicitly invalid, definitely not catch-all
    if (result.smtpStatus === 'invalid') {
      logger.debug(`Not catch-all: domain ${domain} rejected random email`);
      return 'no';
    }
    
    // If temporarily unavailable, greylisting, or unknown - inconclusive
    // Let caller try next MX for a definitive answer
    if (result.smtpStatus === 'temporarily_unavailable' || result.smtpStatus === 'unknown') {
      logger.debug(`Catch-all test inconclusive for ${domain}: ${result.smtpStatus}`);
      return 'inconclusive';
    }
    
    // Default: inconclusive (safer than assuming 'no' for unexpected statuses)
    logger.warn(`Unexpected smtpStatus '${result.smtpStatus}' in catch-all detection for ${domain}`);
    return 'inconclusive';
  } catch (error: any) {
    // Connection errors are inconclusive - let caller try next MX
    logger.debug(`Catch-all detection failed for ${domain}: ${error.message}`);
    return 'inconclusive';
  }
}

/**
 * Create a timeout promise
 */
function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`SMTP operation timeout after ${ms}ms`)), ms);
  });
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
