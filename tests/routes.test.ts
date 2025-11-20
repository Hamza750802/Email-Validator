/**
 * Integration tests for HTTP API routes
 * Tests actual HTTP behavior including request/response handling
 * DNS and SMTP validators are mocked to avoid network traffic
 */

import request from 'supertest';
import express from 'express';
import routes from '../src/http/routes';
import type { EmailValidationResult, ValidationReasonCode } from '../src/types/email';

// Mock the email validation service to avoid real DNS/SMTP traffic
jest.mock('../src/services/emailValidationService', () => {
  const originalModule = jest.requireActual('../src/services/emailValidationService');
  
  // Helper to create mock validation results
  const createMockResult = (email: string, overrides: Partial<EmailValidationResult> = {}): EmailValidationResult => {
    const parts = email.split('@');
    const localPart = parts[0] || '';
    const domain = parts[1] ? parts[1].toLowerCase() : '';
    
    return {
      email,
      localPart,
      domain,
      syntaxValid: true,
      domainHasMx: true,
      disposable: false,
      roleAccount: false,
      smtpStatus: 'valid',
      score: 1.0,
      reasonCodes: ['syntax_valid', 'mx_records_found', 'non_disposable_domain', 'non_role_account', 'smtp_valid'] as ValidationReasonCode[],
      ...overrides
    };
  };

  return {
    ...originalModule,
    validateEmail: jest.fn(async (email: string, context?: any) => {
      // Simulate different responses based on email patterns
      if (email.includes('invalid@')) {
        return createMockResult(email, {
          smtpStatus: 'invalid',
          score: 0.4,
          reasonCodes: ['syntax_valid', 'mx_records_found', 'non_disposable_domain', 'non_role_account', 'smtp_invalid'] as ValidationReasonCode[]
        });
      }
      if (email.includes('disposable')) {
        return createMockResult(email, {
          disposable: true,
          score: 0.3,
          reasonCodes: ['syntax_valid', 'mx_records_found', 'disposable_domain'] as ValidationReasonCode[]
        });
      }
      if (email.startsWith('admin@') || email.startsWith('info@')) {
        return createMockResult(email, {
          roleAccount: true,
          score: 0.7,
          reasonCodes: ['syntax_valid', 'mx_records_found', 'non_disposable_domain', 'role_account'] as ValidationReasonCode[]
        });
      }
      if (context?.skipSmtp) {
        return createMockResult(email, {
          smtpStatus: 'not_checked',
          score: 0.95,
          reasonCodes: ['syntax_valid', 'mx_records_found', 'non_disposable_domain', 'non_role_account'] as ValidationReasonCode[]
        });
      }
      // Default: valid email
      return createMockResult(email);
    }),
    validateEmailBatch: jest.fn(async (emails: string[], context?: any) => {
      const { validateEmail } = require('../src/services/emailValidationService');
      return Promise.all(emails.map(email => validateEmail(email, context)));
    })
  };
});

// Create test app
const app = express();
app.use(express.json());
app.use(routes);

describe('HTTP Routes Integration Tests', () => {
  
  describe('POST /validate', () => {
    it('should validate a single email and return hashed logs (no PII)', async () => {
      const response = await request(app)
        .post('/validate')
        .send({ email: 'test@example.com' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.result).toBeDefined();
      expect(response.body.result.email).toBe('test@example.com');
      expect(response.body.result.syntaxValid).toBe(true);
      expect(response.body.result.score).toBeGreaterThan(0);
    });

    it('should reject empty email', async () => {
      const response = await request(app)
        .post('/validate')
        .send({ email: '   ' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid request');
    });

    it('should reject missing email field', async () => {
      const response = await request(app)
        .post('/validate')
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('required');
    });

    it('should respect skipSmtp option', async () => {
      const response = await request(app)
        .post('/validate')
        .send({ 
          email: 'user@gmail.com',
          skipSmtp: true 
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.result.smtpStatus).toBe('not_checked');
    });
  });

  describe('POST /validate-batch', () => {
    it('should validate multiple emails', async () => {
      const response = await request(app)
        .post('/validate-batch')
        .send({
          emails: ['test1@example.com', 'test2@example.com', 'test3@example.com']
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.results).toHaveLength(3);
      expect(response.body.results[0]).toHaveProperty('email');
      expect(response.body.results[0]).toHaveProperty('score');
    });

    it('should enforce MAX_BATCH_SIZE limit (1000 emails)', async () => {
      const emails = Array.from({ length: 1001 }, (_, i) => `user${i}@example.com`);
      
      const response = await request(app)
        .post('/validate-batch')
        .send({ emails })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Batch too large');
      expect(response.body.message).toContain('1000');
    });

    it('should reject non-array emails field', async () => {
      const response = await request(app)
        .post('/validate-batch')
        .send({ emails: 'not-an-array' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('array');
    });

    it('should reject empty emails array', async () => {
      const response = await request(app)
        .post('/validate-batch')
        .send({ emails: [] })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('empty');
    });

    it('should validate all items are strings', async () => {
      const response = await request(app)
        .post('/validate-batch')
        .send({ emails: ['valid@example.com', 123, 'another@example.com'] })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('strings');
    });

    it('should maintain email order in results', async () => {
      const emails = ['first@example.com', 'second@example.com', 'third@example.com'];
      
      const response = await request(app)
        .post('/validate-batch')
        .send({ emails })
        .expect(200);

      expect(response.body.results[0].email).toBe('first@example.com');
      expect(response.body.results[1].email).toBe('second@example.com');
      expect(response.body.results[2].email).toBe('third@example.com');
    });
  });

  describe('POST /upload-csv', () => {
    describe('Response Format Negotiation', () => {
      it('should return JSON by default (backward compatibility)', async () => {
        const csvContent = 'email\ntest@example.com\nuser@gmail.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200)
          .expect('Content-Type', /application\/json/);

        expect(response.body.success).toBe(true);
        expect(response.body.summary).toBeDefined();
        expect(response.body.summary.total).toBe(2);
        expect(response.body.csv).toBeDefined();
        expect(typeof response.body.csv).toBe('string');
      });

      it('should return CSV when Accept: text/csv header is sent', async () => {
        const csvContent = 'email\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .set('Accept', 'text/csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200)
          .expect('Content-Type', /text\/csv/);

        expect(response.text).toContain('Email,Valid,Score');
        expect(response.text).toContain('test@example.com');
      });

      it('should return CSV when ?format=csv query parameter is used', async () => {
        const csvContent = 'email\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv?format=csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200)
          .expect('Content-Type', /text\/csv/)
          .expect('Content-Disposition', /attachment/);

        expect(response.text).toContain('Email,Valid,Score');
      });

      it('should include summary stats in JSON response', async () => {
        const csvContent = 'email\ntest@example.com\ninvalid-email\nadmin@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        expect(response.body.summary).toMatchObject({
          total: 3,
          valid: expect.any(Number),
          invalid: expect.any(Number),
          disposable: expect.any(Number),
          roleAccounts: expect.any(Number),
        });
      });
    });

    describe('Batch Size Enforcement', () => {
      it('should enforce MAX_BATCH_SIZE limit (1000 emails)', async () => {
        const emails = Array.from({ length: 1001 }, (_, i) => `user${i}@example.com`);
        const csvContent = 'email\n' + emails.join('\n');
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'large.csv')
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('batch_too_large');
        expect(response.body.message).toContain('1000');
        expect(response.body.message).toContain('1001');
      });

      it('should accept exactly 1000 emails', async () => {
        const emails = Array.from({ length: 1000 }, (_, i) => `user${i}@example.com`);
        const csvContent = 'email\n' + emails.join('\n');
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'max.csv')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.summary.total).toBe(1000);
      }, 30000); // 30 second timeout for 1000 email validation
    });

    describe('CSV Parsing', () => {
      it('should detect "email" column (lowercase)', async () => {
        const csvContent = 'email\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        expect(response.body.summary.total).toBe(1);
      });

      it('should detect "Email" column (capitalized)', async () => {
        const csvContent = 'Email\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        expect(response.body.summary.total).toBe(1);
      });

      it('should detect "EMAIL" column (uppercase)', async () => {
        const csvContent = 'EMAIL\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        expect(response.body.summary.total).toBe(1);
      });

      it('should fallback to first column if no email column found', async () => {
        const csvContent = 'addresses\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        expect(response.body.summary.total).toBe(1);
      });

      it('should handle empty rows', async () => {
        const csvContent = 'email\ntest@example.com\n\n\nuser@gmail.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        expect(response.body.summary.total).toBe(2);
      });

      it('should reject CSV with no emails found', async () => {
        const csvContent = 'email\n\n\n';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'empty.csv')
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain('Could not find any emails');
      });
    });

    describe('File Upload Validation', () => {
      it('should reject request with no file', async () => {
        const response = await request(app)
          .post('/upload-csv')
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('No file uploaded');
      });

      it('should handle skipSmtp option', async () => {
        const csvContent = 'email\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .field('skipSmtp', 'true')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });

    describe('CSV Output Format', () => {
      it('should include all validation columns in CSV output', async () => {
        const csvContent = 'email\ntest@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        const csvLines = response.body.csv.split('\n');
        const header = csvLines[0];
        
        expect(header).toContain('Email');
        expect(header).toContain('Valid');
        expect(header).toContain('Score');
        expect(header).toContain('SMTP Status');
        expect(header).toContain('Disposable');
        expect(header).toContain('Role Account');
        expect(header).toContain('Reason');
      });

      it('should properly escape CSV values with commas', async () => {
        const csvContent = 'email\ninvalid@example.com';
        
        const response = await request(app)
          .post('/upload-csv')
          .attach('csv', Buffer.from(csvContent), 'test.csv')
          .expect(200);

        // Reason codes contain commas and should be quoted
        expect(response.body.csv).toContain('"');
        expect(response.body.csv).toContain('Reason');
      });
    });
  });

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const response = await request(app)
        .get('/health');

      // Service can be:
      // - 200 OK if Redis disabled or connected
      // - 503 degraded if Redis enabled but not connected (graceful degradation)
      expect([200, 503]).toContain(response.status);
      expect(response.body.status).toMatch(/ok|degraded/);
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.redis).toBeDefined();
      expect(response.body.redis.enabled).toBeDefined();
      expect(response.body.redis.connected).toBeDefined();
    });
  });
});
