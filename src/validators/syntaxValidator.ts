/**
 * Email syntax validator.
 * Validates email format against RFC 5321/5322 standards.
 * Uses the 'validator' package for robust validation.
 */

import { isEmail } from 'validator';
import { ValidationReasonCode } from '../types/email';

export interface SyntaxValidationResult {
  syntaxValid: boolean;
  localPart: string;
  domain: string;
  reasonCodes: ValidationReasonCode[];
}

/**
 * Validate email syntax and extract components
 * 
 * @param email - Email address to validate
 * @returns Validation result with extracted parts and reason codes
 */
export function validateSyntax(email: string): SyntaxValidationResult {
  const reasonCodes: ValidationReasonCode[] = [];
  
  // Trim whitespace
  const trimmedEmail = email.trim();
  
  // Check for empty string
  if (!trimmedEmail) {
    return {
      syntaxValid: false,
      localPart: '',
      domain: '',
      reasonCodes: ['syntax_invalid', 'syntax_invalid_format'],
    };
  }
  
  // Check for @ sign
  const atCount = (trimmedEmail.match(/@/g) || []).length;
  
  if (atCount === 0) {
    return {
      syntaxValid: false,
      localPart: trimmedEmail,
      domain: '',
      reasonCodes: ['syntax_invalid', 'syntax_missing_at_sign'],
    };
  }
  
  if (atCount > 1) {
    return {
      syntaxValid: false,
      localPart: '',
      domain: '',
      reasonCodes: ['syntax_invalid', 'syntax_multiple_at_signs'],
    };
  }
  
  // Split into local and domain parts
  const [rawLocalPart, rawDomain] = trimmedEmail.split('@');
  
  // Check for empty parts
  if (!rawLocalPart || rawLocalPart.length === 0) {
    return {
      syntaxValid: false,
      localPart: '',
      domain: rawDomain || '',
      reasonCodes: ['syntax_invalid', 'syntax_empty_local_part'],
    };
  }
  
  if (!rawDomain || rawDomain.length === 0) {
    return {
      syntaxValid: false,
      localPart: rawLocalPart,
      domain: '',
      reasonCodes: ['syntax_invalid', 'syntax_empty_domain'],
    };
  }
  
  // Normalize domain to lowercase (domains are case-insensitive)
  // Keep local part as-is (technically case-sensitive, though most servers ignore case)
  const localPart = rawLocalPart;
  const domain = rawDomain.toLowerCase();
  
  // Use validator package for robust RFC compliance check
  const isValid = isEmail(trimmedEmail);
  
  if (!isValid) {
    reasonCodes.push('syntax_invalid');
    reasonCodes.push('syntax_invalid_format');
    return {
      syntaxValid: false,
      localPart,
      domain,
      reasonCodes,
    };
  }
  
  // Additional validation: Check for common invalid patterns
  // Reject if local part starts or ends with a dot
  if (localPart.startsWith('.') || localPart.endsWith('.')) {
    reasonCodes.push('syntax_invalid');
    reasonCodes.push('syntax_invalid_format');
    return {
      syntaxValid: false,
      localPart,
      domain,
      reasonCodes,
    };
  }
  
  // Reject consecutive dots
  if (localPart.includes('..') || domain.includes('..')) {
    reasonCodes.push('syntax_invalid');
    reasonCodes.push('syntax_invalid_format');
    return {
      syntaxValid: false,
      localPart,
      domain,
      reasonCodes,
    };
  }
  
  // All checks passed
  reasonCodes.push('syntax_valid');
  
  return {
    syntaxValid: true,
    localPart,
    domain,
    reasonCodes,
  };
}
