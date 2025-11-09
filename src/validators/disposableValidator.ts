/**
 * Disposable email domain validator.
 * Detects temporary/disposable email addresses from known providers.
 * Uses a comprehensive curated list loaded from data/disposable-domains.json
 * Update the list with: node scripts/update-disposable-domains.js
 */

import { ValidationReasonCode } from '../types/email';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Load disposable domains from JSON file
 */
function loadDisposableDomains(): Set<string> {
  try {
    // Try multiple possible paths (works from both src and dist)
    const possiblePaths = [
      path.join(__dirname, '..', '..', 'data', 'disposable-domains.json'),  // From dist
      path.join(__dirname, '../../data/disposable-domains.json'),            // From src (Jest)
      path.join(process.cwd(), 'data', 'disposable-domains.json')           // From project root
    ];
    
    for (const dataPath of possiblePaths) {
      try {
        if (fs.existsSync(dataPath)) {
          const data = fs.readFileSync(dataPath, 'utf-8');
          const json = JSON.parse(data);
          return new Set<string>(json.domains.map((d: string) => d.toLowerCase()));
        }
      } catch {
        continue;
      }
    }
    
    throw new Error('Disposable domains file not found in any expected location');
  } catch (error) {
    console.error('Failed to load disposable domains, using fallback list:', error);
    // Fallback to a minimal list if file load fails
    return new Set([
      '10minutemail.com',
      'guerrillamail.com',
      'mailinator.com',
      'tempmail.com',
      'throwaway.email',
      'temp-mail.org',
      'yopmail.com',
      'maildrop.cc'
    ]);
  }
}

/**
 * Comprehensive list of known disposable/temporary email domains
 * Loaded from data/disposable-domains.json at module initialization
 */
const DISPOSABLE_DOMAINS = loadDisposableDomains();

/**
 * Result of disposable domain validation
 */
export interface DisposableValidationResult {
  disposable: boolean;
  reasonCodes: ValidationReasonCode[];
}

/**
 * Check if a domain is from a known disposable email provider
 * 
 * Performs both exact match and subdomain matching (e.g., foo.mailinator.com matches mailinator.com)
 * to prevent evasion via subdomains. Input is normalized to lowercase.
 * 
 * @param domain - Domain to check (will be normalized to lowercase)
 * @returns Validation result with disposable flag and reason codes
 */
export function validateDisposable(domain: string): DisposableValidationResult {
  const normalizedDomain = domain.toLowerCase().trim();
  
  // Check exact match first (fastest)
  if (DISPOSABLE_DOMAINS.has(normalizedDomain)) {
    return {
      disposable: true,
      reasonCodes: ['disposable_domain'],
    };
  }
  
  // Check if domain is a subdomain of any disposable domain
  // e.g., foo.mailinator.com should match mailinator.com
  for (const disposableDomain of DISPOSABLE_DOMAINS) {
    if (normalizedDomain.endsWith('.' + disposableDomain)) {
      return {
        disposable: true,
        reasonCodes: ['disposable_domain'],
      };
    }
  }
  
  return {
    disposable: false,
    reasonCodes: ['non_disposable_domain'],
  };
}

/**
 * Get the total count of known disposable domains
 */
export function getDisposableDomainsCount(): number {
  return DISPOSABLE_DOMAINS.size;
}
