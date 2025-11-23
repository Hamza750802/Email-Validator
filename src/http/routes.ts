/**
 * HTTP API routes for email validation service.
 * Provides REST endpoints for single and batch email validation.
 */

import { createHash } from 'crypto';
import { Router, Request, Response } from 'express';
import { validateEmail, validateEmailBatch } from '../services/emailValidationService';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { redisClient } from '../utils/redis';
import { config } from '../config/env';
import multer from 'multer';
import { Readable } from 'stream';
import csvParser from 'csv-parser';
import * as XLSX from 'xlsx';

const router = Router();

// Configure multer for file uploads (CSV and Excel)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    // Accept CSV and Excel files
    const allowedMimes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    const allowedExts = ['.csv', '.xls', '.xlsx'];
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files (.csv, .xls, .xlsx) are allowed'));
    }
  }
});

/**
 * Hash email for privacy-safe logging (PII protection)
 * Returns first 8 chars of SHA256 hash for log correlation
 */
function hashEmailForLogging(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 8);
}

/**
 * Maximum number of emails allowed in batch validation
 */
const MAX_BATCH_SIZE = 1000;

/**
 * Health check endpoint
 * GET /health
 */
router.get('/health', async (_req: Request, res: Response) => {
  const redisConnected = redisClient.isConnected();
  const redisError = redisClient.getLastError();
  
  // Service is healthy if:
  // - App is running (obviously)
  // - Redis is either disabled, or enabled and connected
  const isHealthy = !config.redis.enabled || redisConnected;
  
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    service: 'ValidR Email Validation API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    redis: {
      enabled: config.redis.enabled,
      connected: redisConnected,
      error: redisError?.message || null,
      mode: redisConnected ? 'distributed' : 'in-memory-fallback',
    },
  });
});

/**
 * Basic metrics endpoint
 * GET /metrics/basic
 */
router.get('/metrics/basic', (_req: Request, res: Response) => {
  const metricsData = metrics.getMetrics();
  
  res.json({
    ...metricsData,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Validate a single email address
 * POST /validate
 * 
 * Request body:
 * {
 *   "email": "test@example.com",
 *   "skipSmtp": false  // optional, defaults to false
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "result": { ...EmailValidationResult }
 * }
 */
router.post('/validate', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { email, skipSmtp } = req.body;
    
    // Validate request
    if (!email || typeof email !== 'string') {
      logger.warn('POST /validate - Invalid request: missing or invalid email field');
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'Field "email" is required and must be a string',
      });
    }
    
    // Trim whitespace
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'Email address cannot be empty',
      });
    }
    
    const emailHash = hashEmailForLogging(trimmedEmail);
    const domain = trimmedEmail.split('@')[1] || 'unknown';
    
    logger.info(`POST /validate - Validating email`, { emailHash, domain });
    
    // Perform validation
    const result = await validateEmail(trimmedEmail, { skipSmtp: skipSmtp === true });
    
    const duration = Date.now() - startTime;
    
    logger.info(`POST /validate - Completed in ${duration}ms`, {
      emailHash,
      domain,
      score: result.score,
      valid: result.syntaxValid && result.domainHasMx,
      timeMs: duration,
    });
    
    logger.debug(`POST /validate - Result summary`, {
      syntaxValid: result.syntaxValid,
      domainHasMx: result.domainHasMx,
      disposable: result.disposable,
      roleAccount: result.roleAccount,
      smtpStatus: result.smtpStatus,
    });
    
    return res.json({
      success: true,
      result,
    });
    
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error(`POST /validate - Error after ${duration}ms:`, error);
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'An error occurred while validating the email address',
    });
  }
});

/**
 * Validate multiple email addresses in batch
 * POST /validate-batch
 * 
 * Request body:
 * {
 *   "emails": ["a@example.com", "b@example.com"],
 *   "skipSmtp": false  // optional, defaults to false
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "results": [ { ...EmailValidationResult }, ... ]
 * }
 */
router.post('/validate-batch', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { emails, skipSmtp } = req.body;
    
    // Validate request - emails must be an array
    if (!emails || !Array.isArray(emails)) {
      logger.warn('POST /validate-batch - Invalid request: missing or invalid emails field');
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'Field "emails" is required and must be an array',
      });
    }
    
    // Check batch size limit
    if (emails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'Field "emails" cannot be empty',
      });
    }
    
    if (emails.length > MAX_BATCH_SIZE) {
      logger.warn(`POST /validate-batch - Batch too large: ${emails.length} emails (max ${MAX_BATCH_SIZE})`);
      return res.status(400).json({
        success: false,
        error: 'Batch too large',
        message: `Maximum ${MAX_BATCH_SIZE} emails allowed per batch. Received ${emails.length}.`,
      });
    }
    
    // Validate all items are strings
    const invalidItems = emails.filter(e => typeof e !== 'string');
    if (invalidItems.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'All items in "emails" array must be strings',
      });
    }
    
    // Trim all emails
    const trimmedEmails = emails.map(e => e.trim()).filter(e => e.length > 0);
    
    if (trimmedEmails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'No valid email addresses provided',
      });
    }
    
    logger.info(`POST /validate-batch - Validating ${trimmedEmails.length} emails`);
    
    // Perform batch validation with small concurrency (respect global SMTP limits)
    const results = await validateEmailBatch(
      trimmedEmails,
      { skipSmtp: skipSmtp === true },
      5 // Small concurrency to respect SMTP throttling
    );
    
    const duration = Date.now() - startTime;
    
    // Calculate stats for logging
    const stats = {
      total: results.length,
      syntaxValid: results.filter(r => r.syntaxValid).length,
      domainHasMx: results.filter(r => r.domainHasMx).length,
      disposable: results.filter(r => r.disposable).length,
      roleAccount: results.filter(r => r.roleAccount).length,
      smtpValid: results.filter(r => r.smtpStatus === 'valid').length,
      smtpInvalid: results.filter(r => r.smtpStatus === 'invalid').length,
      avgScore: (results.reduce((sum, r) => sum + r.score, 0) / results.length).toFixed(2),
    };
    
    logger.info(`POST /validate-batch - Completed ${results.length} emails in ${duration}ms`, {
      count: results.length,
      timeMs: duration,
      avgTimePerEmail: Math.round(duration / results.length),
    });
    
    logger.debug(`POST /validate-batch - Batch summary`, stats);
    
    return res.json({
      success: true,
      results,
    });
    
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error(`POST /validate-batch - Error after ${duration}ms:`, error);
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'An error occurred while validating the email addresses',
    });
  }
});

/**
 * Extract emails from uploaded file (CSV or Excel)
 */
async function extractEmailsFromFile(file: Express.Multer.File): Promise<string[]> {
  const emails: string[] = [];
  const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
  
  if (ext === '.xlsx' || ext === '.xls') {
    // Parse Excel file
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
    
    // Find email column (check first row for headers)
    let emailColumnIndex = -1;
    if (data.length > 0) {
      const headers = data[0];
      emailColumnIndex = headers.findIndex((h: any) => 
        h && typeof h === 'string' && 
        /email/i.test(h.toString().trim())
      );
    }
    
    // If no email column found, use first column
    if (emailColumnIndex === -1) {
      emailColumnIndex = 0;
    }
    
    // Extract emails (skip header row if found)
    const startRow = data[0] && typeof data[0][emailColumnIndex] === 'string' && 
                      /email/i.test(data[0][emailColumnIndex]) ? 1 : 0;
    
    for (let i = startRow; i < data.length; i++) {
      const row = data[i];
      if (row && row[emailColumnIndex]) {
        const email = row[emailColumnIndex].toString().trim();
        if (email && email.includes('@')) {
          emails.push(email);
        }
      }
    }
  } else {
    // Parse CSV file
    const stream = Readable.from(file.buffer.toString());
    
    await new Promise<void>((resolve, reject) => {
      stream
        .pipe(csvParser())
        .on('data', (row) => {
          // Try to find email column (common names)
          const email = row.email || row.Email || row.EMAIL || 
                       row['email address'] || row['Email Address'] ||
                       Object.values(row)[0]; // Fallback to first column
          
          if (email && typeof email === 'string' && email.trim()) {
            emails.push(email.trim());
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });
  }
  
  return emails;
}

/**
 * Upload and validate CSV or Excel file
 * POST /upload-csv
 * 
 * Accepts CSV or Excel file with emails, validates them, and returns results
 */
router.post('/upload-csv', upload.single('csv'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
        message: 'Please upload a CSV file',
      });
    }
    
    const fileType = req.file.originalname.toLowerCase().slice(req.file.originalname.lastIndexOf('.'));
    logger.info(`POST /upload-csv - Processing ${fileType} file: ${req.file.originalname}`);
    
    // Extract emails from file (works for both CSV and Excel)
    const emails = await extractEmailsFromFile(req.file);
    
    if (emails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No emails found',
        message: 'Could not find any emails in the file. Make sure you have an "email" column or emails in the first column.',
      });
    }
    
    // Enforce batch size limit (same as /validate-batch)
    if (emails.length > MAX_BATCH_SIZE) {
      logger.warn(`POST /upload-csv - Batch too large: ${emails.length} emails (max ${MAX_BATCH_SIZE})`);
      return res.status(400).json({
        success: false,
        error: 'batch_too_large',
        message: `Maximum ${MAX_BATCH_SIZE} emails allowed per upload. Received ${emails.length}. Please split into smaller files.`,
      });
    }
    
    logger.info(`POST /upload-csv - Found ${emails.length} emails to validate`);
    
    // Validate emails
    const skipSmtp = req.body.skipSmtp === 'true';
    const results = await validateEmailBatch(emails, { skipSmtp }, 5);
    
    // Generate CSV output
    const csvLines = ['Email,Valid,Score,SMTP Status,Disposable,Role Account,Reason'];
    
    results.forEach(result => {
      const valid = result.syntaxValid && result.domainHasMx && result.score >= 0.7;
      const reason = result.reasonCodes.join('; ');
      
      csvLines.push([
        result.email,
        valid ? 'Yes' : 'No',
        result.score.toFixed(2),
        result.smtpStatus,
        result.disposable ? 'Yes' : 'No',
        result.roleAccount ? 'Yes' : 'No',
        `"${reason}"` // Quote to handle commas in reason
      ].join(','));
    });
    
    const csvOutput = csvLines.join('\n');
    
    // Calculate summary stats
    const summary = {
      total: results.length,
      valid: results.filter(r => r.syntaxValid && r.domainHasMx && r.score >= 0.7).length,
      invalid: results.filter(r => !r.syntaxValid || !r.domainHasMx || r.score < 0.7).length,
      disposable: results.filter(r => r.disposable).length,
      roleAccounts: results.filter(r => r.roleAccount).length,
    };
    
    const duration = Date.now() - startTime;
    
    logger.info(`POST /upload-csv - Completed`, {
      emails: results.length,
      valid: summary.valid,
      invalid: summary.invalid,
      timeMs: duration,
    });
    
    // Default to JSON for backward compatibility
    // Client can request CSV download via Accept: text/csv or ?format=csv
    const acceptHeader = req.headers.accept || '';
    const wantsCsv = acceptHeader.includes('text/csv') || req.query.format === 'csv';
    
    if (wantsCsv) {
      // Return downloadable CSV file
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="validated-emails-${Date.now()}.csv"`);
      return res.send(csvOutput);
    } else {
      // Default: Return JSON with embedded CSV for web UI and existing clients
      return res.json({
        success: true,
        summary,
        csv: csvOutput,
      });
    }
    
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error(`POST /upload-csv - Error after ${duration}ms:`, error);
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message || 'An error occurred while processing the CSV file',
    });
  }
});

export default router;
