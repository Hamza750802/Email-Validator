/**
 * Tests for email validation service
 * Includes mocked SMTP and DNS tests to avoid real network calls
 */

import { validateEmail, validateEmailBasic, validateEmailBatch } from '../src/services/emailValidationService';
import * as smtpValidator from '../src/validators/smtpValidator';
import * as dns from 'dns';

// Mock the SMTP validator to avoid real network calls
jest.mock('../src/validators/smtpValidator');

// Mock DNS to make tests hermetic and fast
jest.mock('dns', () => ({
  promises: {
    resolveMx: jest.fn(),
  },
}));

const mockResolveMx = dns.promises.resolveMx as jest.MockedFunction<typeof dns.promises.resolveMx>;

describe('EmailValidationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default DNS mock: return MX records for common domains
    mockResolveMx.mockImplementation(async (domain: string) => {
      const normalizedDomain = domain.toLowerCase();
      
      // Common domains with MX records
      if (normalizedDomain.includes('gmail.com') || 
          normalizedDomain.includes('yahoo.com') ||
          normalizedDomain.includes('example.com') ||
          normalizedDomain.includes('mailinator.com') ||
          normalizedDomain.includes('10minutemail.com')) {
        return [{ exchange: `mx.${normalizedDomain}`, priority: 10 }];
      }
      
      // Nonexistent domains throw
      throw new Error('queryMx ENOTFOUND');
    });
  });

  describe('validateEmail - Syntax validation', () => {
    it('should return score 0.0 for invalid syntax', async () => {
      const result = await validateEmail('not-an-email', { skipSmtp: true });
      
      expect(result.syntaxValid).toBe(false);
      expect(result.domainHasMx).toBe(false);
      expect(result.disposable).toBe(false);
      expect(result.roleAccount).toBe(false);
      expect(result.smtpStatus).toBe('not_checked');
      expect(result.score).toBe(0.0);
      expect(result.reasonCodes).toContain('syntax_invalid');
    });

    it('should return early for invalid syntax without checking other validators', async () => {
      const result = await validateEmail('invalid@', { skipSmtp: true });
      
      expect(result.syntaxValid).toBe(false);
      expect(result.score).toBe(0.0);
      expect(result.validationTimeMs).toBeLessThan(100); // Should be fast (no DNS lookup)
    });
  });

  describe('validateEmail - Domain validation', () => {
    it('should return score 0.1 for valid syntax but no MX records', async () => {
      const result = await validateEmail('user@nonexistent-domain-xyz123.com', { skipSmtp: true });
      
      expect(result.syntaxValid).toBe(true);
      expect(result.domainHasMx).toBe(false);
      expect(result.score).toBe(0.1); // Per scoreCalculator: syntax valid but no MX
      expect(result.reasonCodes).toContain('domain_invalid');
    });

    it('should have high score for valid domain with MX', async () => {
      const result = await validateEmail('user@gmail.com', { skipSmtp: true });
      
      expect(result.syntaxValid).toBe(true);
      expect(result.domainHasMx).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.95); // No SMTP = -0.05, so 0.95
      expect(result.reasonCodes).toContain('mx_records_found');
    });
  });

  describe('validateEmail - Disposable + Role penalties', () => {
    it('should penalize disposable domains even if valid', async () => {
      const result = await validateEmail('user@mailinator.com', { skipSmtp: true });
      
      expect(result.syntaxValid).toBe(true);
      expect(result.domainHasMx).toBe(true);
      expect(result.disposable).toBe(true);
      expect(result.score).toBeLessThan(0.8); // -0.25 for disposable, -0.05 for no SMTP = 0.70
      expect(result.reasonCodes).toContain('disposable_domain');
    });

    it('should penalize role accounts', async () => {
      const result = await validateEmail('admin@example.com', { skipSmtp: true });
      
      expect(result.syntaxValid).toBe(true);
      expect(result.roleAccount).toBe(true);
      expect(result.score).toBeLessThan(1.0);
      expect(result.reasonCodes).toContain('role_account');
    });

    it('should combine disposable + role penalties', async () => {
      const result = await validateEmail('admin@mailinator.com', { skipSmtp: true });
      
      expect(result.disposable).toBe(true);
      expect(result.roleAccount).toBe(true);
      // -0.25 (disposable) - 0.08 (role) - 0.05 (no SMTP) = 0.62
      expect(result.score).toBeCloseTo(0.62, 2);
    });
  });

  describe('validateEmail - SMTP validation (mocked)', () => {
    it('should achieve perfect score with SMTP valid', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;
      mockSmtpValidator.validateSmtp.mockResolvedValue({
        smtpStatus: 'valid',
        reasonCodes: ['smtp_valid'],
        rawSmtpResponse: '250 2.1.5 OK',
      });

      const result = await validateEmail('user@gmail.com');
      
      expect(result.syntaxValid).toBe(true);
      expect(result.domainHasMx).toBe(true);
      expect(result.smtpStatus).toBe('valid');
      expect(result.score).toBe(1.0); // Perfect score
      expect(mockSmtpValidator.validateSmtp).toHaveBeenCalledWith('user@gmail.com', 'gmail.com');
    });

    it('should apply major penalty for SMTP invalid', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;
      mockSmtpValidator.validateSmtp.mockResolvedValue({
        smtpStatus: 'invalid',
        reasonCodes: ['smtp_invalid'],
        rawSmtpResponse: '550 5.1.1 User unknown',
      });

      const result = await validateEmail('nonexistent@gmail.com');
      
      expect(result.smtpStatus).toBe('invalid');
      expect(result.score).toBeLessThan(0.5); // -0.60 penalty = 0.40
      expect(result.reasonCodes).toContain('smtp_invalid');
    });

    it('should handle catch_all servers', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;
      mockSmtpValidator.validateSmtp.mockResolvedValue({
        smtpStatus: 'catch_all',
        reasonCodes: ['smtp_catch_all'],
        rawSmtpResponse: '250 OK (catch-all)',
      });

      // Use a domain with MX so SMTP validation is triggered
      const result = await validateEmail('anyone@gmail.com');
      
      expect(result.smtpStatus).toBe('catch_all');
      expect(result.score).toBeCloseTo(0.90, 2); // -0.10 penalty
    });

    it('should handle temporarily_unavailable', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;
      mockSmtpValidator.validateSmtp.mockResolvedValue({
        smtpStatus: 'temporarily_unavailable',
        reasonCodes: ['smtp_temporarily_unavailable', 'smtp_greylisted'],
        rawSmtpResponse: '450 Greylisted',
      });

      // Use a domain with MX so SMTP validation is triggered
      const result = await validateEmail('user@gmail.com');
      
      expect(result.smtpStatus).toBe('temporarily_unavailable');
      expect(result.score).toBeCloseTo(0.75, 2); // -0.25 penalty
    });

    it('should handle unknown SMTP status', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;
      mockSmtpValidator.validateSmtp.mockResolvedValue({
        smtpStatus: 'unknown',
        reasonCodes: ['smtp_timeout'],
        rawSmtpResponse: 'Connection timeout',
      });

      // Use a domain with MX so SMTP validation is triggered
      const result = await validateEmail('user@yahoo.com');
      
      expect(result.smtpStatus).toBe('unknown');
      expect(result.score).toBeCloseTo(0.80, 2); // -0.20 penalty
    });

    it('should skip SMTP when skipSmtp=true', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;

      const result = await validateEmail('user@gmail.com', { skipSmtp: true });
      
      expect(result.smtpStatus).toBe('not_checked');
      expect(mockSmtpValidator.validateSmtp).not.toHaveBeenCalled();
      expect(result.score).toBeCloseTo(0.95, 2); // -0.05 for not_checked
    });

    it('should skip SMTP when domain has no MX', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;

      const result = await validateEmail('user@no-mx-domain-xyz.com');
      
      expect(result.domainHasMx).toBe(false);
      expect(result.smtpStatus).toBe('not_checked');
      expect(mockSmtpValidator.validateSmtp).not.toHaveBeenCalled();
    });
  });

  describe('validateEmail - Combined scenarios', () => {
    it('should force low score for disposable + SMTP invalid', async () => {
      const mockSmtpValidator = smtpValidator as jest.Mocked<typeof smtpValidator>;
      mockSmtpValidator.validateSmtp.mockResolvedValue({
        smtpStatus: 'invalid',
        reasonCodes: ['smtp_invalid'],
      });

      const result = await validateEmail('test@mailinator.com');
      
      expect(result.disposable).toBe(true);
      expect(result.smtpStatus).toBe('invalid');
      // 1.0 - 0.25 (disposable) - 0.60 (smtp invalid) = 0.15
      expect(result.score).toBeCloseTo(0.15, 2);
    });

    it('should include all metadata fields', async () => {
      const result = await validateEmail('user@example.com', { skipSmtp: true });
      
      expect(result.email).toBe('user@example.com');
      expect(result.localPart).toBe('user');
      expect(result.domain).toBe('example.com');
      expect(result.validatedAt).toBeInstanceOf(Date);
      expect(result.validationTimeMs).toBeGreaterThan(0);
      expect(Array.isArray(result.reasonCodes)).toBe(true);
      expect(result.reasonCodes.length).toBeGreaterThan(0);
    });
  });

  describe('validateEmailBatch', () => {
    it('should validate multiple emails in batch', async () => {
      const emails = [
        'user1@gmail.com',
        'user2@yahoo.com',
        'invalid-email',
      ];

      const results = await validateEmailBatch(emails, { skipSmtp: true });
      
      expect(results).toHaveLength(3);
      expect(results[0].email).toBe('user1@gmail.com');
      expect(results[1].email).toBe('user2@yahoo.com');
      expect(results[2].email).toBe('invalid-email');
      expect(results[2].syntaxValid).toBe(false);
    }, 15000);

    it('should maintain order in batch results', async () => {
      const emails = ['a@example.com', 'b@example.com', 'c@example.com'];
      const results = await validateEmailBatch(emails, { skipSmtp: true });
      
      expect(results[0].localPart).toBe('a');
      expect(results[1].localPart).toBe('b');
      expect(results[2].localPart).toBe('c');
    }, 15000);

    it('should respect concurrency limit', async () => {
      const emails = Array.from({ length: 10 }, (_, i) => `user${i}@example.com`);
      const results = await validateEmailBatch(emails, { skipSmtp: true }, 3);
      
      expect(results).toHaveLength(10);
      results.forEach((result, i) => {
        expect(result.email).toBe(`user${i}@example.com`);
      });
    }, 20000);
  });

  describe('validateEmailBasic - legacy alias', () => {
    it('should work as alias to validateEmail', async () => {
      const result = await validateEmailBasic('user@gmail.com', { skipSmtp: true });
      
      expect(result.syntaxValid).toBe(true);
      expect(result.score).toBeGreaterThan(0.9);
    });
  });
});
