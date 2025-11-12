/**
 * Provider-specific heuristics for parsing SMTP responses
 * Different providers use different error codes and patterns
 */

export interface ProviderHint {
  provider: 'gmail' | 'outlook' | 'yahoo' | 'protonmail' | 'icloud' | 'zoho' | 'generic';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * Detect email provider from MX hostname
 */
export function detectProvider(mxHost: string): ProviderHint['provider'] {
  const lowerHost = mxHost.toLowerCase();

  // Gmail / Google Workspace
  if (lowerHost.includes('google.com') || lowerHost.includes('googlemail.com')) {
    return 'gmail';
  }

  // Outlook / Microsoft 365 / Hotmail
  if (
    lowerHost.includes('outlook.com') ||
    lowerHost.includes('hotmail.com') ||
    lowerHost.includes('protection.outlook.com') ||
    lowerHost.includes('olc.protection.outlook.com')
  ) {
    return 'outlook';
  }

  // Yahoo / AOL (Yahoo owns AOL)
  if (lowerHost.includes('yahoodns.net') || lowerHost.includes('aol.com')) {
    return 'yahoo';
  }

  // ProtonMail
  if (lowerHost.includes('protonmail.ch') || lowerHost.includes('protonmail.com')) {
    return 'protonmail';
  }

  // iCloud / Apple
  if (lowerHost.includes('apple.com') || lowerHost.includes('icloud.com')) {
    return 'icloud';
  }

  // Zoho
  if (lowerHost.includes('zoho.com') || lowerHost.includes('zohomail.com')) {
    return 'zoho';
  }

  return 'generic';
}

/**
 * Parse Gmail-specific SMTP responses
 * Gmail uses specific error codes and patterns
 */
function parseGmailResponse(response: string): ProviderHint | null {
  const lower = response.toLowerCase();

  // 550-5.1.1 - User unknown (definitive invalid)
  if (response.includes('550-5.1.1') || response.includes('550 5.1.1')) {
    if (lower.includes('does not exist') || lower.includes('recipient address rejected')) {
      return {
        provider: 'gmail',
        confidence: 'high',
        reason: 'Gmail 550-5.1.1: User does not exist'
      };
    }
  }

  // 550-5.7.1 - Policy rejection (could be invalid or blocked sender)
  if (response.includes('550-5.7.1') || response.includes('550 5.7.1')) {
    return {
      provider: 'gmail',
      confidence: 'medium',
      reason: 'Gmail 550-5.7.1: Policy rejection (likely invalid or spam filter)'
    };
  }

  // 450-4.2.1 - Greylisting / rate limiting (try again later)
  if (response.includes('450-4.2.1') || response.includes('450 4.2.1')) {
    return {
      provider: 'gmail',
      confidence: 'low',
      reason: 'Gmail 450-4.2.1: Temporary issue (greylisting or rate limit)'
    };
  }

  // 250 2.1.5 - Success (valid recipient)
  if (response.includes('250 2.1.5')) {
    return {
      provider: 'gmail',
      confidence: 'high',
      reason: 'Gmail 250 2.1.5: Recipient OK'
    };
  }

  return null;
}

/**
 * Parse Outlook/Microsoft-specific SMTP responses
 * Microsoft uses different patterns than Gmail
 */
function parseOutlookResponse(response: string): ProviderHint | null {
  const lower = response.toLowerCase();

  // 550 5.1.1 - User unknown
  if (response.includes('550 5.1.1')) {
    if (lower.includes('recipient address rejected') || lower.includes('user unknown')) {
      return {
        provider: 'outlook',
        confidence: 'high',
        reason: 'Outlook 550 5.1.1: User unknown'
      };
    }
  }

  // 550 5.4.1 - Recipient address rejected (no such user)
  if (response.includes('550 5.4.1')) {
    return {
      provider: 'outlook',
      confidence: 'high',
      reason: 'Outlook 550 5.4.1: Recipient address rejected'
    };
  }

  // 550 5.7.1 - Delivery not authorized (sender issue, not necessarily invalid recipient)
  if (response.includes('550 5.7.1')) {
    if (lower.includes('delivery not authorized') || lower.includes('relay access denied')) {
      return {
        provider: 'outlook',
        confidence: 'low',
        reason: 'Outlook 550 5.7.1: Delivery not authorized (sender reputation issue)'
      };
    }
  }

  // 450 4.7.0 - Temporary failure (often greylisting)
  if (response.includes('450 4.7.0') || response.includes('421 4.7.0')) {
    return {
      provider: 'outlook',
      confidence: 'low',
      reason: 'Outlook 450/421 4.7.0: Temporary failure (greylisting)'
    };
  }

  // 250 2.1.5 - Success
  if (response.includes('250 2.1.5')) {
    return {
      provider: 'outlook',
      confidence: 'high',
      reason: 'Outlook 250 2.1.5: Recipient OK'
    };
  }

  return null;
}

/**
 * Parse Yahoo-specific SMTP responses
 * Yahoo is more aggressive with blocking verification attempts
 */
function parseYahooResponse(response: string): ProviderHint | null {
  const lower = response.toLowerCase();

  // 554 - Permanent failure (often catch-all or blocking verification)
  if (response.startsWith('554')) {
    if (lower.includes('delivery error') || lower.includes('not available')) {
      return {
        provider: 'yahoo',
        confidence: 'medium',
        reason: 'Yahoo 554: Delivery error (could be invalid or catch-all behavior)'
      };
    }
  }

  // 421 - Service not available (rate limiting)
  if (response.startsWith('421')) {
    return {
      provider: 'yahoo',
      confidence: 'low',
      reason: 'Yahoo 421: Service not available (rate limiting or temporary block)'
    };
  }

  // 250 - Success (but Yahoo sometimes accepts all addresses)
  if (response.includes('250')) {
    return {
      provider: 'yahoo',
      confidence: 'medium',
      reason: 'Yahoo 250: Accepted (note: Yahoo may use catch-all behavior)'
    };
  }

  return null;
}

/**
 * Parse ProtonMail-specific responses
 * ProtonMail is privacy-focused and often doesn't reveal if addresses exist
 */
function parseProtonmailResponse(response: string): ProviderHint | null {
  // ProtonMail often accepts all RCPT TO to protect privacy
  if (response.includes('250')) {
    return {
      provider: 'protonmail',
      confidence: 'low',
      reason: 'ProtonMail 250: Accepted (ProtonMail uses catch-all for privacy)'
    };
  }

  // 550 - Usually means the domain itself has issues
  if (response.startsWith('550')) {
    return {
      provider: 'protonmail',
      confidence: 'medium',
      reason: 'ProtonMail 550: Rejected (likely domain-level issue)'
    };
  }

  return null;
}

/**
 * Parse iCloud-specific responses
 * Apple/iCloud uses strict anti-spam measures
 */
function parseIcloudResponse(response: string): ProviderHint | null {
  // 550 5.1.1 - User unknown
  if (response.includes('550 5.1.1')) {
    return {
      provider: 'icloud',
      confidence: 'high',
      reason: 'iCloud 550 5.1.1: User unknown'
    };
  }

  // 554 - Rejected (often for sender reputation)
  if (response.startsWith('554')) {
    return {
      provider: 'icloud',
      confidence: 'medium',
      reason: 'iCloud 554: Rejected (sender reputation or invalid recipient)'
    };
  }

  // 250 - Success
  if (response.includes('250')) {
    return {
      provider: 'icloud',
      confidence: 'high',
      reason: 'iCloud 250: Recipient OK'
    };
  }

  return null;
}

/**
 * Main function: Parse provider-specific SMTP response
 * Returns enhanced interpretation based on provider patterns
 */
export function parseProviderResponse(mxHost: string, smtpResponse: string): ProviderHint {
  const provider = detectProvider(mxHost);

  let hint: ProviderHint | null = null;

  switch (provider) {
    case 'gmail':
      hint = parseGmailResponse(smtpResponse);
      break;
    case 'outlook':
      hint = parseOutlookResponse(smtpResponse);
      break;
    case 'yahoo':
      hint = parseYahooResponse(smtpResponse);
      break;
    case 'protonmail':
      hint = parseProtonmailResponse(smtpResponse);
      break;
    case 'icloud':
      hint = parseIcloudResponse(smtpResponse);
      break;
    default:
      // Generic parsing for unknown providers
      break;
  }

  // If provider-specific parsing found something, return it
  if (hint) {
    return hint;
  }

  // Fallback: Generic parsing
  return parseGenericResponse(provider, smtpResponse);
}

/**
 * Generic SMTP response parsing for unknown providers
 */
function parseGenericResponse(provider: ProviderHint['provider'], response: string): ProviderHint {
  const lower = response.toLowerCase();

  // 250 - Success
  if (response.startsWith('250')) {
    return {
      provider,
      confidence: 'medium',
      reason: 'Generic 250: Accepted (provider-specific behavior unknown)'
    };
  }

  // 550 5.1.1 - User unknown (most common definitive rejection)
  if (response.includes('550 5.1.1') || response.includes('550-5.1.1')) {
    return {
      provider,
      confidence: 'high',
      reason: 'Generic 550 5.1.1: User unknown'
    };
  }

  // 550 - Permanent failure (various reasons)
  if (response.startsWith('550')) {
    if (lower.includes('user unknown') || lower.includes('does not exist') || lower.includes('no such user')) {
      return {
        provider,
        confidence: 'high',
        reason: 'Generic 550: User does not exist'
      };
    }
    return {
      provider,
      confidence: 'medium',
      reason: 'Generic 550: Permanent failure (reason unclear)'
    };
  }

  // 450/451/452 - Temporary failure (greylisting, rate limits, mailbox full)
  if (response.startsWith('450') || response.startsWith('451') || response.startsWith('452')) {
    return {
      provider,
      confidence: 'low',
      reason: 'Generic 450/451/452: Temporary failure (greylisting or rate limit)'
    };
  }

  // 421/554 - Service issues or policy rejections
  if (response.startsWith('421') || response.startsWith('554')) {
    return {
      provider,
      confidence: 'low',
      reason: 'Generic 421/554: Service unavailable or policy rejection'
    };
  }

  // Unknown response
  return {
    provider,
    confidence: 'low',
    reason: `Unknown response pattern: ${response.substring(0, 50)}`
  };
}

/**
 * Enhance validation status with provider hints
 * Adjusts confidence based on provider-specific knowledge
 */
export function enhanceWithProviderHints(
  status: 'valid' | 'invalid' | 'inconclusive',
  mxHost: string,
  smtpResponse: string
): {
  status: 'valid' | 'invalid' | 'inconclusive';
  confidence: 'high' | 'medium' | 'low';
  providerHint: ProviderHint;
} {
  const hint = parseProviderResponse(mxHost, smtpResponse);

  // Adjust status based on provider-specific knowledge
  let finalStatus = status;

  // Special case: ProtonMail/Yahoo often accept all addresses
  if ((hint.provider === 'protonmail' || hint.provider === 'yahoo') && status === 'valid') {
    finalStatus = 'inconclusive'; // Don't trust acceptance from privacy-focused providers
  }

  // Special case: Gmail/Outlook high-confidence rejections
  if ((hint.provider === 'gmail' || hint.provider === 'outlook') && hint.confidence === 'high' && smtpResponse.includes('550')) {
    finalStatus = 'invalid'; // Trust high-confidence rejections
  }

  return {
    status: finalStatus,
    confidence: hint.confidence,
    providerHint: hint
  };
}
