/**
 * Role account validator.
 * Detects generic/role-based email addresses that are typically shared mailboxes
 * rather than individual user accounts (e.g., admin@, support@, sales@).
 */

import { ValidationReasonCode } from '../types/email';

/**
 * Common role-based email prefixes
 * These are typically shared mailboxes rather than individual accounts
 */
const ROLE_PREFIXES = new Set([
  // Administrative
  'admin',
  'administrator',
  'webmaster',
  'hostmaster',
  'postmaster',
  'root',
  'sysadmin',
  'moderator',
  
  // Support & Service
  'support',
  'help',
  'helpdesk',
  'service',
  'services',
  'contact',
  'hello',
  'info',
  'information',
  
  // Sales & Marketing
  'sales',
  'marketing',
  'advertising',
  'media',
  'press',
  'pr',
  
  // Business Functions
  'billing',
  'accounts',
  'finance',
  'hr',
  'legal',
  'compliance',
  'security',
  'privacy',
  
  // General Team
  'team',
  'office',
  'staff',
  'general',
  'all',
  'everyone',
  
  // Technical
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'bounce',
  'bounces',
  'notifications',
  'notification',
  'alerts',
  'alert',
  
  // Recruitment
  'jobs',
  'careers',
  'recruiting',
  'recruitment',
  'talent',
  
  // Feedback
  'feedback',
  'suggestions',
  'complaints',
  'abuse',
  
  // Partners & Vendors
  'partners',
  'vendor',
  'vendors',
  'suppliers',
  
  // Corporate
  'ceo',
  'cto',
  'cfo',
  'coo',
  'cmo',
  'executive',
  'executives',
]);

export interface RoleValidationResult {
  roleAccount: boolean;
  reasonCodes: ValidationReasonCode[];
}

/**
 * Check if an email's local part is a common role-based address
 * 
 * @param localPart - Local part of email (before @)
 * @returns Validation result with role flag and reason codes
 */
export function validateRole(localPart: string): RoleValidationResult {
  const normalizedLocal = localPart.toLowerCase().trim();
  
  // Check direct match
  const isRole = ROLE_PREFIXES.has(normalizedLocal);
  
  if (isRole) {
    return {
      roleAccount: true,
      reasonCodes: ['role_account'],
    };
  }
  
  // Check for common patterns with numbers/separators
  // e.g., "support1", "admin-test", "info_sales", "info.desk"
  // First try: remove trailing numbers and check
  const withoutTrailingNumbers = normalizedLocal.replace(/[0-9]+$/, '');
  if (ROLE_PREFIXES.has(withoutTrailingNumbers)) {
    return {
      roleAccount: true,
      reasonCodes: ['role_account'],
    };
  }
  
  // Second try: check if starts with any role prefix followed by separator
  for (const prefix of ROLE_PREFIXES) {
    if (normalizedLocal === prefix) continue; // Already checked above
    
    // Check if local part starts with role prefix + separator (-, _, ., +, or number)
    const pattern = new RegExp(`^${prefix}[-_.+0-9]`);
    if (pattern.test(normalizedLocal)) {
      return {
        roleAccount: true,
        reasonCodes: ['role_account'],
      };
    }
  }
  
  return {
    roleAccount: false,
    reasonCodes: ['non_role_account'],
  };
}

/**
 * Get the total count of known role prefixes
 */
export function getRolePrefixesCount(): number {
  return ROLE_PREFIXES.size;
}
