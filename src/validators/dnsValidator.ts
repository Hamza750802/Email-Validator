/**
 * DNS and MX record validator.
 * Queries DNS for MX records to verify domain can receive email.
 * Uses in-memory caching to reduce DNS queries and improve performance.
 */

import { promises as dns } from 'dns';
import { ValidationReasonCode, MxRecord } from '../types/email';
import { cache } from '../utils/cache';
import { logger } from '../utils/logger';

export interface MxValidationResult {
  domainHasMx: boolean;
  mxRecords?: MxRecord[];
  reasonCodes: ValidationReasonCode[];
}

/**
 * Validate that a domain has valid MX records for receiving email
 * 
 * @param domain - Domain name to check (should be lowercase)
 * @param ttlMs - Cache TTL in milliseconds (optional, defaults to 10 minutes)
 * @returns Validation result with MX records and reason codes
 */
export async function validateMx(
  domain: string,
  ttlMs?: number
): Promise<MxValidationResult> {
  const reasonCodes: ValidationReasonCode[] = [];
  const normalizedDomain = domain.toLowerCase();
  
  // Check cache first
  const cachedMx = await cache.getMxFromCache(normalizedDomain);
  if (cachedMx !== null) {
    reasonCodes.push('cache_hit');
    
    if (cachedMx.length > 0) {
      reasonCodes.push('mx_records_found');
      reasonCodes.push('domain_valid');
      return {
        domainHasMx: true,
        mxRecords: cachedMx,
        reasonCodes,
      };
    } else {
      reasonCodes.push('no_mx_records');
      reasonCodes.push('domain_invalid');
      return {
        domainHasMx: false,
        mxRecords: [],
        reasonCodes,
      };
    }
  }
  
  reasonCodes.push('cache_miss');
  
  try {
    logger.debug(`Performing DNS MX lookup for domain: ${normalizedDomain}`);
    
    // Query DNS for MX records
    const mxRecords = await dns.resolveMx(normalizedDomain);
    
    // Sort by priority (lower number = higher priority)
    const sortedRecords: MxRecord[] = mxRecords
      .map(record => ({
        exchange: record.exchange.toLowerCase(),
        priority: record.priority,
      }))
      .sort((a, b) => a.priority - b.priority);
    
    logger.debug(`MX lookup successful for ${normalizedDomain}`, {
      recordCount: sortedRecords.length,
      records: sortedRecords,
    });
    
    // Cache the results
    await cache.setMxInCache(normalizedDomain, sortedRecords, ttlMs);
    
    if (sortedRecords.length === 0) {
      reasonCodes.push('no_mx_records');
      reasonCodes.push('domain_invalid');
      return {
        domainHasMx: false,
        mxRecords: [],
        reasonCodes,
      };
    }
    
    reasonCodes.push('mx_records_found');
    reasonCodes.push('domain_valid');
    
    return {
      domainHasMx: true,
      mxRecords: sortedRecords,
      reasonCodes,
    };
    
  } catch (error: any) {
    logger.debug(`MX lookup failed for ${normalizedDomain}`, {
      error: error.message,
      code: error.code,
    });
    
    // Handle different DNS error codes
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
      // Domain doesn't exist or has no MX records
      reasonCodes.push('no_mx_records');
      reasonCodes.push('domain_invalid');
      
      // Cache negative result to avoid repeated lookups
      await cache.setMxInCache(normalizedDomain, [], ttlMs);
      
      return {
        domainHasMx: false,
        mxRecords: [],
        reasonCodes,
      };
    }
    
    if (error.code === 'ETIMEOUT' || error.code === 'ETIMEDOUT') {
      reasonCodes.push('dns_timeout');
      reasonCodes.push('domain_invalid');
      
      // Don't cache timeout results - might be temporary
      return {
        domainHasMx: false,
        reasonCodes,
      };
    }
    
    // Generic DNS failure
    reasonCodes.push('dns_lookup_failed');
    reasonCodes.push('domain_invalid');
    
    logger.warn(`DNS lookup error for ${normalizedDomain}`, error);
    
    return {
      domainHasMx: false,
      reasonCodes,
    };
  }
}
