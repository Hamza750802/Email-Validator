/**
 * Tests for score calculator
 * Validates the scoring algorithm for all validation scenarios
 */

import { calculateScore } from '../src/validators/scoreCalculator';

describe('ScoreCalculator', () => {
  describe('Perfect scores', () => {
    it('should return 1.0 for perfect email with SMTP valid', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'valid',
      });
      
      expect(score).toBe(1.0);
    });

    it('should return 0.95 when SMTP is not checked', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.95);
    });
  });

  describe('Invalid syntax', () => {
    it('should return 0.0 for invalid syntax regardless of other factors', () => {
      const score = calculateScore({
        syntaxValid: false,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'valid',
      });
      
      expect(score).toBe(0.0);
    });

    it('should return 0.0 for invalid syntax even with no MX', () => {
      const score = calculateScore({
        syntaxValid: false,
        domainHasMx: false,
        disposable: true,
        roleAccount: true,
        smtpStatus: 'invalid',
      });
      
      expect(score).toBe(0.0);
    });
  });

  describe('Domain validation', () => {
    it('should return 0.1 for valid syntax but no MX records', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: false,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.1);
    });

    it('should return 0.1 for no MX even if SMTP was attempted', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: false,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'unknown',
      });
      
      expect(score).toBe(0.1);
    });
  });

  describe('Disposable domains', () => {
    it('should apply -0.25 penalty for disposable domains', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: true,
        roleAccount: false,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.70); // 1.0 - 0.25 - 0.05
    });

    it('should handle disposable domain with SMTP valid', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: true,
        roleAccount: false,
        smtpStatus: 'valid',
      });
      
      expect(score).toBe(0.75); // 1.0 - 0.25
    });

    it('should combine disposable with no MX penalty', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: false,
        disposable: true,
        roleAccount: false,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.1); // Min score after no MX
    });
  });

  describe('Role accounts', () => {
    it('should apply -0.08 penalty for role accounts', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: true,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.87); // 1.0 - 0.08 - 0.05
    });

    it('should handle role account with SMTP valid', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: true,
        smtpStatus: 'valid',
      });
      
      expect(score).toBe(0.92); // 1.0 - 0.08
    });
  });

  describe('Combined penalties', () => {
    it('should combine disposable + role penalties', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: true,
        roleAccount: true,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBeCloseTo(0.62, 2); // 1.0 - 0.25 - 0.08 - 0.05
    });

    it('should combine disposable + role + SMTP invalid', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: true,
        roleAccount: true,
        smtpStatus: 'invalid',
      });
      
      expect(score).toBeCloseTo(0.07, 2); // 1.0 - 0.25 - 0.08 - 0.60
    });
  });

  describe('SMTP status variations', () => {
    it('should apply -0.60 penalty for SMTP invalid', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'invalid',
      });
      
      expect(score).toBe(0.40); // 1.0 - 0.60
    });

    it('should apply -0.10 penalty for catch_all', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'catch_all',
      });
      
      expect(score).toBe(0.90); // 1.0 - 0.10
    });

    it('should apply -0.25 penalty for temporarily_unavailable', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'temporarily_unavailable',
      });
      
      expect(score).toBe(0.75); // 1.0 - 0.25
    });

    it('should apply -0.20 penalty for unknown SMTP status', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'unknown',
      });
      
      expect(score).toBe(0.80); // 1.0 - 0.20
    });
  });

  describe('Edge cases', () => {
    it('should never return negative scores', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: false,
        disposable: true,
        roleAccount: true,
        smtpStatus: 'invalid',
      });
      
      expect(score).toBeGreaterThanOrEqual(0.0);
      expect(score).toBe(0.1); // No MX caps at 0.1
    });

    it('should never return scores above 1.0', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'valid',
      });
      
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should round to 2 decimal places', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: true,
        roleAccount: true,
        smtpStatus: 'not_checked',
      });
      
      // 1.0 - 0.25 - 0.08 - 0.05 = 0.62
      const decimalPlaces = (score.toString().split('.')[1] || '').length;
      expect(decimalPlaces).toBeLessThanOrEqual(2);
    });
  });

  describe('Real-world scenarios', () => {
    it('should score typical Gmail address highly', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'valid',
      });
      
      expect(score).toBe(1.0);
    });

    it('should score mailinator address moderately', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: true,
        roleAccount: false,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.70);
    });

    it('should score admin@company.com with minor penalty', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: true,
        disposable: false,
        roleAccount: true,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.87);
    });

    it('should score non-existent domain very low', () => {
      const score = calculateScore({
        syntaxValid: true,
        domainHasMx: false,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.1);
    });

    it('should score invalid syntax as 0', () => {
      const score = calculateScore({
        syntaxValid: false,
        domainHasMx: false,
        disposable: false,
        roleAccount: false,
        smtpStatus: 'not_checked',
      });
      
      expect(score).toBe(0.0);
    });
  });
});
