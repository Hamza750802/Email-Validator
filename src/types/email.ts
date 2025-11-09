/**
 * Core types and interfaces for email validation.
 * These types are shared across all validators and the orchestration service.
 */

/**
 * SMTP validation status
 */
export type SmtpStatus = 
  | "not_checked"              // SMTP validation not performed
  | "valid"                    // SMTP server accepted the address
  | "invalid"                  // SMTP server rejected the address
  | "unknown"                  // Unable to determine (timeout, error, etc.)
  | "catch_all"                // Domain accepts all addresses
  | "temporarily_unavailable"; // Temporary failure (greylisting, etc.)

/**
 * Validation reason codes for detailed failure/success reporting
 */
export type ValidationReasonCode =
  // Syntax validation
  | "syntax_valid"
  | "syntax_invalid"
  | "syntax_invalid_format"
  | "syntax_invalid_characters"
  | "syntax_missing_at_sign"
  | "syntax_multiple_at_signs"
  | "syntax_empty_local_part"
  | "syntax_empty_domain"
  
  // DNS/MX validation
  | "domain_valid"
  | "domain_invalid"
  | "no_mx_records"
  | "mx_records_found"
  | "dns_lookup_failed"
  | "dns_timeout"
  
  // Disposable domain detection
  | "disposable_domain"
  | "non_disposable_domain"
  
  // Role account detection
  | "role_account"
  | "non_role_account"
  
  // SMTP validation
  | "smtp_valid"
  | "smtp_invalid"
  | "smtp_catch_all"
  | "smtp_temporarily_unavailable"
  | "smtp_connection_failed"
  | "smtp_timeout"
  | "smtp_greylisted"
  | "smtp_rate_limited"
  | "smtp_soft_fails_exceeded"
  | "smtp_hard_block"
  
  // Caching
  | "cache_hit"
  | "cache_miss";

/**
 * Complete email validation result with all checks and scoring
 */
export interface EmailValidationResult {
  /** Original email address provided */
  email: string;
  
  /** Local part of email (before @) */
  localPart: string;
  
  /** Domain part of email (after @) - normalized to lowercase */
  domain: string;
  
  /** Whether email syntax is valid per RFC standards */
  syntaxValid: boolean;
  
  /** Whether domain has valid MX records */
  domainHasMx: boolean;
  
  /** Whether domain is a known disposable/temporary email provider */
  disposable: boolean;
  
  /** Whether email is a role-based account (admin@, info@, etc.) */
  roleAccount: boolean;
  
  /** Result of SMTP handshake verification */
  smtpStatus: SmtpStatus;
  
  /** Overall validation score from 0.0 (invalid) to 1.0 (highly valid) */
  score: number;
  
  /** List of all reason codes from validation process */
  reasonCodes: ValidationReasonCode[];
  
  /** Raw SMTP response for debugging (optional) */
  rawSmtpResponse?: string;
  
  /** Timestamp of validation */
  validatedAt?: Date;
  
  /** Time taken for validation in milliseconds */
  validationTimeMs?: number;
}

/**
 * MX record information
 */
export interface MxRecord {
  exchange: string;
  priority: number;
}

/**
 * Cached MX lookup result
 */
export interface CachedMxResult {
  domain: string;
  mxRecords: MxRecord[];
  cachedAt: number;
  expiresAt: number;
}
