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
    
    // Step 2: Try MX hosts in priority order
    const sortedMx = mxResult.mxRecords.sort((a, b) => a.priority - b.priority);
    
    for (const mx of sortedMx) {
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
        
        // Otherwise, try next MX host
        logger.debug(`MX ${mx.exchange} returned ${result.smtpStatus}, trying next...`);
      } catch (error: any) {
        logger.warn(`Error validating with MX ${mx.exchange}:`, error.message);
        // Continue to next MX
      }
    }
    
    // All MX hosts failed or returned unknown
    logger.warn(`All MX hosts failed or returned unknown for ${email}`);
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_timeout', 'smtp_connection_failed'],
      rawSmtpResponse: 'All MX hosts failed or timed out',
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
 * Perform SMTP handshake: Connect -> EHLO -> MAIL FROM -> RCPT TO -> QUIT
 */
async function performSmtpHandshake(
  socket: Socket,
  mxHost: string,
  email: string,
  cfg: SmtpValidationConfig
): Promise<SmtpValidationResult> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let step = 0; // 0=connect, 1=ehlo, 2=mail, 3=rcpt
    let rawResponse = '';
    
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
          continue; // Wait for final line
        }
        
        // Process based on current step
        if (step === 0) {
          // Server greeting (220)
          if (code !== 220) {
            return reject(new Error(`Unexpected greeting: ${line}`));
          }
          // Send EHLO
          const ehlo = `EHLO ${cfg.heloDomain}\r\n`;
          logger.debug(`SMTP [${mxHost}] >>> ${ehlo.trim()}`);
          socket.write(ehlo);
          step = 1;
          
        } else if (step === 1) {
          // EHLO response (250)
          if (code !== 250) {
            return reject(new Error(`EHLO rejected: ${line}`));
          }
          // Send MAIL FROM
          const mailFrom = `MAIL FROM:<${cfg.mailFrom}>\r\n`;
          logger.debug(`SMTP [${mxHost}] >>> ${mailFrom.trim()}`);
          socket.write(mailFrom);
          step = 2;
          
        } else if (step === 2) {
          // MAIL FROM response (250)
          if (code !== 250) {
            return reject(new Error(`MAIL FROM rejected: ${line}`));
          }
          // Send RCPT TO (the actual validation)
          const rcptTo = `RCPT TO:<${email}>\r\n`;
          logger.debug(`SMTP [${mxHost}] >>> ${rcptTo.trim()}`);
          socket.write(rcptTo);
          step = 3;
          
        } else if (step === 3) {
          // RCPT TO response - this determines if email is valid
          const quit = 'QUIT\r\n';
          socket.write(quit);
          
          const result = interpretSmtpCode(code, line, rawResponse);
          return resolve(result);
        }
      }
    });
    
    socket.on('error', (err) => {
      reject(err);
    });
    
    socket.on('timeout', () => {
      reject(new Error('Socket timeout'));
    });
    
    socket.on('end', () => {
      if (step < 3) {
        reject(new Error('Connection closed prematurely'));
      }
    });
    
    // Connect to MX host
    socket.setTimeout(cfg.connectTimeoutMs);
    socket.connect(25, mxHost);
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
    
    if (code === 421 || lowerMessage.includes('greylist')) {
      reasonCodes.push('smtp_greylisted');
    }
    if (lowerMessage.includes('rate') || lowerMessage.includes('throttle')) {
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
  
  // Connection/timeout errors
  if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
    return {
      smtpStatus: 'unknown',
      reasonCodes: ['smtp_timeout'],
      rawSmtpResponse: message,
    };
  }
  
  return {
    smtpStatus: 'unknown',
    reasonCodes: ['smtp_connection_failed'],
    rawSmtpResponse: message,
  };
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
