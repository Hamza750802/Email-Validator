/**
 * Multi-tenant request context for future SaaS features
 * 
 * CURRENT STATUS: Optional and unused (prepared for future)
 * FUTURE USE: Authentication, rate limiting, billing, audit logs
 * 
 * WHEN TO IMPLEMENT:
 *   1. Add API key authentication middleware
 *   2. Attach RequestContext to each validated request
 *   3. Use userId/apiKeyId for rate limiting
 *   4. Use tier for feature gating
 *   5. Log userId for audit trails
 * 
 * INTEGRATION POINTS:
 *   - src/http/routes.ts: Extract API key from Authorization header
 *   - src/services/emailValidationService.ts: Pass context to validators
 *   - src/utils/throttleState.ts: Apply tier-based rate limits
 *   - Future: src/middleware/auth.ts: Validate API keys, attach context
 */

/**
 * Subscription tier for rate limiting and feature access
 * 
 * FREE TIER:
 *   - 100 validations/day
 *   - Standard rate limits (conservative)
 *   - No batch validation
 *   - No priority support
 * 
 * STANDARD TIER ($19/month):
 *   - 10,000 validations/month
 *   - Faster rate limits
 *   - Batch validation up to 500
 *   - Email support
 * 
 * PREMIUM TIER ($99/month):
 *   - 100,000 validations/month
 *   - Aggressive rate limits
 *   - Batch validation up to 5,000
 *   - Priority support
 *   - Webhook callbacks
 * 
 * ENTERPRISE (custom pricing):
 *   - Unlimited validations
 *   - Custom rate limits
 *   - Dedicated infrastructure
 *   - SLA guarantees
 */
export enum SubscriptionTier {
  FREE = 'free',
  STANDARD = 'standard',
  PREMIUM = 'premium',
  ENTERPRISE = 'enterprise',
}

/**
 * Request context for multi-tenant SaaS
 * 
 * OPTIONAL IN ALL FUNCTION SIGNATURES (for now)
 * Allows gradual migration to authenticated API
 */
export interface RequestContext {
  /**
   * User ID (from your user database)
   * TODO: Link to users table when auth is implemented
   */
  userId?: string;
  
  /**
   * API key ID (for tracking which key was used)
   * TODO: Link to api_keys table when auth is implemented
   */
  apiKeyId?: string;
  
  /**
   * Subscription tier (for rate limiting and feature gating)
   * Defaults to FREE if not authenticated
   */
  tier: SubscriptionTier;
  
  /**
   * Organization ID (for team accounts)
   * TODO: Implement when adding team features
   */
  orgId?: string;
  
  /**
   * Request ID for tracing (generated per request)
   * Useful for debugging and audit logs
   */
  requestId?: string;
  
  /**
   * Client IP address (for rate limiting fallback)
   * Use when not authenticated
   */
  ipAddress?: string;
  
  /**
   * Custom metadata (for future extensibility)
   */
  metadata?: Record<string, any>;
}

/**
 * Create default request context for unauthenticated requests
 * 
 * CURRENT USAGE: All requests use this until auth is implemented
 */
export function createDefaultContext(ipAddress?: string): RequestContext {
  return {
    tier: SubscriptionTier.FREE,
    requestId: generateRequestId(),
    ipAddress,
  };
}

/**
 * Generate unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
