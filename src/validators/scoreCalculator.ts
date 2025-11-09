/**
 * Email validation scoring calculator.
 * 
 * Computes a numerical score (0.0 - 1.0) based on all validation checks.
 * Higher scores indicate more deliverable/valid emails.
 * 
 * Scoring philosophy:
 * - Start from 1.0 (perfect)
 * - Apply penalties for various issues
 * - Syntax invalid or no MX = critical failure (near 0)
 * - SMTP invalid = major penalty
 * - Disposable/role = moderate penalties
 * - Catch-all/unknown = small uncertainty penalties
 */

import { SmtpStatus } from '../types/email';

/**
 * Input for score calculation
 */
export interface ScoreInput {
  syntaxValid: boolean;
  domainHasMx: boolean;
  disposable: boolean;
  roleAccount: boolean;
  smtpStatus: SmtpStatus;
}

/**
 * Calculate overall validation score.
 * 
 * Score interpretation:
 * - 0.95-1.0: Highly deliverable, verified mailbox
 * - 0.80-0.94: Likely deliverable, minor issues
 * - 0.50-0.79: Questionable, moderate concerns
 * - 0.20-0.49: High risk, major issues
 * - 0.00-0.19: Invalid or critical failures
 * 
 * @param input - Aggregated validation results
 * @returns Score between 0.0 and 1.0
 */
export function calculateScore(input: ScoreInput): number {
  let score = 1.0;
  
  // CRITICAL FAILURES: Return very low score immediately
  
  // Invalid syntax = instant fail
  if (!input.syntaxValid) {
    return 0.0;
  }
  
  // No MX records = critical failure (domain can't receive mail)
  if (!input.domainHasMx) {
    return 0.1; // Slightly above 0 since syntax was valid
  }
  
  // SMTP STATUS PENALTIES
  // These are the most important indicators of deliverability
  
  switch (input.smtpStatus) {
    case 'valid':
      // Perfect - mailbox verified as deliverable
      // No penalty
      break;
      
    case 'catch_all':
      // Server accepts all addresses - can't verify specific mailbox
      // Small penalty for uncertainty
      score -= 0.10;
      break;
      
    case 'invalid':
      // Mailbox explicitly rejected or doesn't exist
      // Major penalty - likely undeliverable
      score -= 0.60;
      break;
      
    case 'temporarily_unavailable':
      // Temporary SMTP error (greylisting, rate limit, server issue)
      // Moderate penalty - may be deliverable later
      score -= 0.25;
      break;
      
    case 'unknown':
      // Couldn't determine status (timeout, unexpected error)
      // Moderate penalty for uncertainty
      score -= 0.20;
      break;
      
    case 'not_checked':
      // SMTP validation was skipped
      // Small penalty for lack of verification
      score -= 0.05;
      break;
  }
  
  // DOMAIN QUALITY PENALTIES
  
  // Disposable/temporary email provider
  // Moderate penalty - technically deliverable but low quality
  if (input.disposable) {
    score -= 0.25;
  }
  
  // Role/shared mailbox (admin@, info@, noreply@, etc.)
  // Small penalty - valid but not a personal mailbox
  if (input.roleAccount) {
    score -= 0.08;
  }
  
  // Ensure score stays within bounds
  score = Math.max(0.0, Math.min(1.0, score));
  
  // Round to 2 decimal places for consistency
  return Math.round(score * 100) / 100;
}

/**
 * Get human-readable interpretation of a score.
 * Useful for API responses and logging.
 * 
 * @param score - Validation score (0.0 - 1.0)
 * @returns Descriptive quality label
 */
export function getScoreLabel(score: number): string {
  if (score >= 0.95) return 'excellent';
  if (score >= 0.80) return 'good';
  if (score >= 0.50) return 'questionable';
  if (score >= 0.20) return 'poor';
  return 'invalid';
}

/**
 * Determine if an email should be considered deliverable based on score.
 * Conservative threshold - only recommend accepting high-quality addresses.
 * 
 * @param score - Validation score (0.0 - 1.0)
 * @param threshold - Minimum acceptable score (default: 0.70)
 * @returns True if email meets deliverability threshold
 */
export function isDeliverable(score: number, threshold: number = 0.70): boolean {
  return score >= threshold;
}
