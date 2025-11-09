/**
 * Tests for syntax validator
 */

import { validateSyntax } from '../src/validators/syntaxValidator';

describe('SyntaxValidator', () => {
  describe('Valid emails', () => {
    it('should validate standard email addresses', () => {
      const result = validateSyntax('user@example.com');
      expect(result.syntaxValid).toBe(true);
      expect(result.localPart).toBe('user');
      expect(result.domain).toBe('example.com');
      expect(result.reasonCodes).toContain('syntax_valid');
    });

    it('should validate email with subdomain', () => {
      const result = validateSyntax('user@mail.example.com');
      expect(result.syntaxValid).toBe(true);
      expect(result.domain).toBe('mail.example.com');
    });

    it('should normalize domain to lowercase', () => {
      const result = validateSyntax('User@Example.COM');
      expect(result.syntaxValid).toBe(true);
      expect(result.domain).toBe('example.com');
    });

    it('should handle plus addressing', () => {
      const result = validateSyntax('user+tag@example.com');
      expect(result.syntaxValid).toBe(true);
      expect(result.localPart).toBe('user+tag');
    });

    it('should handle dots in local part', () => {
      const result = validateSyntax('first.last@example.com');
      expect(result.syntaxValid).toBe(true);
      expect(result.localPart).toBe('first.last');
    });
  });

  describe('Invalid emails', () => {
    it('should reject email without @', () => {
      const result = validateSyntax('userexample.com');
      expect(result.syntaxValid).toBe(false);
      expect(result.reasonCodes).toContain('syntax_missing_at_sign');
    });

    it('should reject email with multiple @', () => {
      const result = validateSyntax('user@@example.com');
      expect(result.syntaxValid).toBe(false);
      expect(result.reasonCodes).toContain('syntax_multiple_at_signs');
    });

    it('should reject empty string', () => {
      const result = validateSyntax('');
      expect(result.syntaxValid).toBe(false);
      expect(result.reasonCodes).toContain('syntax_invalid');
    });

    it('should reject email with empty local part', () => {
      const result = validateSyntax('@example.com');
      expect(result.syntaxValid).toBe(false);
      expect(result.reasonCodes).toContain('syntax_empty_local_part');
    });

    it('should reject email with empty domain', () => {
      const result = validateSyntax('user@');
      expect(result.syntaxValid).toBe(false);
      expect(result.reasonCodes).toContain('syntax_empty_domain');
    });

    it('should reject email starting with dot', () => {
      const result = validateSyntax('.user@example.com');
      expect(result.syntaxValid).toBe(false);
      expect(result.reasonCodes).toContain('syntax_invalid');
    });

    it('should reject email with consecutive dots', () => {
      const result = validateSyntax('user..name@example.com');
      expect(result.syntaxValid).toBe(false);
      expect(result.reasonCodes).toContain('syntax_invalid');
    });
  });

  describe('Edge cases', () => {
    it('should trim whitespace', () => {
      const result = validateSyntax('  user@example.com  ');
      expect(result.syntaxValid).toBe(true);
      expect(result.localPart).toBe('user');
      expect(result.domain).toBe('example.com');
    });
  });
});
