export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  meta?: unknown;
}

class Logger {
  private minLevel: LogLevel;

  constructor() {
    const logLevelEnv = process.env.LOG_LEVEL?.toUpperCase();
    
    if (logLevelEnv && Object.values(LogLevel).includes(logLevelEnv as LogLevel)) {
      this.minLevel = logLevelEnv as LogLevel;
    } else {
      const env = process.env.NODE_ENV || 'development';
      this.minLevel = env === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
    }
  }

  getMinLevel(): LogLevel {
    return this.minLevel;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private format(entry: LogEntry): string {
    const base = `[${entry.timestamp}] [${entry.level}] ${entry.message}`;
    
    if (entry.meta !== undefined) {
      const metaStr = typeof entry.meta === 'object' 
        ? JSON.stringify(entry.meta, null, 2)
        : String(entry.meta);
      return `${base}\n${metaStr}`;
    }
    
    return base;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentIndex = levels.indexOf(level);
    const minIndex = levels.indexOf(this.minLevel);
    return currentIndex >= minIndex;
  }

  debug(message: string, meta?: unknown): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    console.log(this.format({ timestamp: new Date().toISOString(), level: LogLevel.DEBUG, message, meta }));
  }

  info(message: string, meta?: unknown): void {
    if (!this.shouldLog(LogLevel.INFO)) return;
    console.log(this.format({ timestamp: new Date().toISOString(), level: LogLevel.INFO, message, meta }));
  }

  warn(message: string, meta?: unknown): void {
    if (!this.shouldLog(LogLevel.WARN)) return;
    console.warn(this.format({ timestamp: new Date().toISOString(), level: LogLevel.WARN, message, meta }));
  }

  error(message: string, error?: unknown): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;
    
    let meta: unknown = error;
    
    if (error instanceof Error) {
      meta = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    
    console.error(this.format({ timestamp: new Date().toISOString(), level: LogLevel.ERROR, message, meta }));
  }
}

export const logger = new Logger();