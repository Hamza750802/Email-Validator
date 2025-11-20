/**
 * Tests for disposable domain validator
 */

import { validateDisposable, getDisposableDomainsCount } from '../src/validators/disposableValidator';

describe('DisposableValidator', () => {
  it('should detect common disposable domains', () => {
    const disposableDomains = [
      'mailinator.com',
      'guerrillamail.com',
      'tempmail.com',
      '10minutemail.com',
      'yopmail.com',
    ];

    disposableDomains.forEach(domain => {
      const result = validateDisposable(domain);
      expect(result.disposable).toBe(true);
      expect(result.reasonCodes).toContain('disposable_domain');
    });
  });

  it('should accept legitimate domains', () => {
    const legitimateDomains = [
      'gmail.com',
      'yahoo.com',
      'outlook.com',
      'example.com',
      'company.co.uk',
    ];

    legitimateDomains.forEach(domain => {
      const result = validateDisposable(domain);
      expect(result.disposable).toBe(false);
      expect(result.reasonCodes).toContain('non_disposable_domain');
    });
  });

  it('should be case-insensitive', () => {
    const result1 = validateDisposable('MAILINATOR.COM');
    const result2 = validateDisposable('mailinator.com');
    const result3 = validateDisposable('Mailinator.Com');

    expect(result1.disposable).toBe(true);
    expect(result2.disposable).toBe(true);
    expect(result3.disposable).toBe(true);
  });

  it('should have a substantial list of disposable domains', () => {
    const count = getDisposableDomainsCount();
    expect(count).toBeGreaterThan(100); // Should have a good-sized list
  });
});
