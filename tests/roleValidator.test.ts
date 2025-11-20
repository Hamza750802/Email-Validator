/**
 * Tests for role account validator
 */

import { validateRole, getRolePrefixesCount } from '../src/validators/roleValidator';

describe('RoleValidator', () => {
  it('should detect common role accounts', () => {
    const roleAccounts = [
      'admin',
      'support',
      'info',
      'sales',
      'contact',
      'hello',
      'noreply',
      'postmaster',
      'webmaster',
      'billing',
    ];

    roleAccounts.forEach(local => {
      const result = validateRole(local);
      expect(result.roleAccount).toBe(true);
      expect(result.reasonCodes).toContain('role_account');
    });
  });

  it('should accept personal email addresses', () => {
    const personalAccounts = [
      'john.doe',
      'jane.smith',
      'user123',
      'myemail',
      'firstname.lastname',
    ];

    personalAccounts.forEach(local => {
      const result = validateRole(local);
      expect(result.roleAccount).toBe(false);
      expect(result.reasonCodes).toContain('non_role_account');
    });
  });

  it('should detect role accounts with numbers', () => {
    const result1 = validateRole('support1');
    const result2 = validateRole('admin123');
    
    expect(result1.roleAccount).toBe(true);
    expect(result2.roleAccount).toBe(true);
  });

  it('should detect role accounts with separators', () => {
    const result1 = validateRole('support-team');
    const result2 = validateRole('admin_user');
    const result3 = validateRole('info.desk');
    
    expect(result1.roleAccount).toBe(true);
    expect(result2.roleAccount).toBe(true);
    expect(result3.roleAccount).toBe(true);
  });

  it('should be case-insensitive', () => {
    const result1 = validateRole('ADMIN');
    const result2 = validateRole('Admin');
    const result3 = validateRole('admin');

    expect(result1.roleAccount).toBe(true);
    expect(result2.roleAccount).toBe(true);
    expect(result3.roleAccount).toBe(true);
  });

  it('should have a substantial list of role prefixes', () => {
    const count = getRolePrefixesCount();
    expect(count).toBeGreaterThan(30); // Should have a comprehensive list
  });
});
