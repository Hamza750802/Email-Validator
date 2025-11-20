/**
 * Express application bootstrap.
 * Sets up HTTP server with routes and middleware.
 */

import express, { Application, Request, Response } from 'express';
import { join } from 'path';
import { config, validateConfig } from '../config/env';
import { logger } from '../utils/logger';
import routes from './routes';

/**
 * Create and configure Express application
 */
export function createApp(): Application {
  const app = express();

  // Body parsing middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files (web UI)
  app.use(express.static(join(__dirname, '../../public')));

  // Request logging middleware
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`, {
      query: req.query,
      ip: req.ip,
    });
    next();
  });

  // API routes
  app.use('/', routes);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: 'Not Found',
      message: 'The requested endpoint does not exist',
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
    logger.error('Unhandled error in request', err);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: config.nodeEnv === 'development' ? err.message : 'An error occurred',
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export function startServer(): void {
  try {
    // Validate configuration before starting
    validateConfig();
    logger.info('Configuration validated successfully');

    // Create app
    const app = createApp();

    // Start listening
    app.listen(config.port, () => {
      logger.info(`🚀 ValidR email validator service started`, {
        port: config.port,
        env: config.nodeEnv,
        heloDomain: config.smtp.heloDomain,
        maxConcurrency: config.smtp.maxGlobalConcurrency,
      });
      logger.info(`Health check available at: http://localhost:${config.port}/health`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Start server if this file is executed directly
if (require.main === module) {
  startServer();
}
