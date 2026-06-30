import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All recognised log levels from most verbose to least. */
export const LOG_LEVELS = ['silly', 'debug', 'http', 'info', 'warn', 'error', 'fatal'] as const;

/** Readonly lookup: level name → numeric priority (lower = more verbose). */
export const LOG_LEVEL_MAP: Record<string, number> = {
  silly: 0,
  debug: 1,
  http: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
};

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogDestination = 'console' | 'file';

// ---------------------------------------------------------------------------
// Default configuration values
// ---------------------------------------------------------------------------

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_FILE_LOG_LEVEL: LogLevel = 'debug';
const DEFAULT_LOG_FILE = path.resolve('storage', 'logs', 'app.log');
const DEFAULT_MAX_LOG_FILES = 7;
const DEFAULT_MAX_LOG_SIZE_MB = 10;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  /** Minimum log level for the console destination. */
  consoleLevel?: LogLevel;
  /** Minimum log level for the file destination. */
  fileLevel?: LogLevel;
  /** Path to the log file. */
  filePath?: string;
  /** Maximum number of rotated log files to keep. */
  maxLogFiles?: number;
  /** Maximum log file size in MB before rotation. */
  maxLogSizeMB?: number;
  /** Whether to colour console output (default: true when TTY). */
  colour?: boolean;
}

export interface LogEntry {
  timestamp: string;        // ISO-8601 UTC
  level: LogLevel;
  message: string;
  service: string;
  correlationId?: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map of ANSI color codes for terminal readability. */
const COLORS: Record<LogLevel, string> = {
  silly: '37',      // white
  debug: '36',      // cyan
  http: '32',       // green
  info: '96',       // bright cyan
  warn: '93',       // bright yellow
  error: '91',      // bright red
  fatal: '41',      // white on red
};

function epochNow(): string {
  return new Date().toISOString();
}

function generateCorrelationId(): string {
  // Simple session-based ID so all logs within a process share one identifier.
  return 'corr-' + Math.random().toString(36).substring(2, 10);
}

// ---------------------------------------------------------------------------
// Logger class
// ---------------------------------------------------------------------------

export class Logger {
  private readonly consoleLevel: number;
  private readonly fileLevel: number;
  private readonly filePath: string;
  private readonly maxLogFiles: number;
  private readonly maxLogSizeMB: number;
  private readonly colour: boolean;
  private readonly service: string;
  private readonly correlationId: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(options: LoggerOptions = {}) {
    this.consoleLevel = LOG_LEVEL_MAP[options.consoleLevel ?? DEFAULT_LOG_LEVEL];
    this.fileLevel = LOG_LEVEL_MAP[options.fileLevel ?? DEFAULT_FILE_LOG_LEVEL];
    this.filePath = options.filePath ?? DEFAULT_LOG_FILE;
    this.maxLogFiles = options.maxLogFiles ?? DEFAULT_MAX_LOG_FILES;
    this.maxLogSizeMB = options.maxLogSizeMB ?? DEFAULT_MAX_LOG_SIZE_MB;
    this.colour = options.colour ?? process.stdout.isTTY;
    this.service = process.env.SERVICE_NAME ?? 'transcoder';
    this.correlationId = generateCorrelationId();
  }

  /**
   * Returns the name of the console log level.
   */
  public getConsoleLevel(): LogLevel {
    const keys = Object.keys(LOG_LEVEL_MAP) as LogLevel[];
    return keys.find((key) => LOG_LEVEL_MAP[key] === this.consoleLevel) ?? 'info';
  }

  /**
   * Returns the name of the file log level.
   */
  public getFileLevel(): LogLevel {
    const keys = Object.keys(LOG_LEVEL_MAP) as LogLevel[];
    return keys.find((key) => LOG_LEVEL_MAP[key] === this.fileLevel) ?? 'debug';
  }

  /**
   * Returns the configuration file path destination.
   */
  public getLogFilePath(): string {
    return this.filePath;
  }

  // --- public level methods ---------------------------------------------

  silly(message: string, context?: Record<string, unknown>): void {
    this.write('silly', message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  http(message: string, context?: Record<string, unknown>): void {
    this.write('http', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  fatal(message: string, context?: Record<string, unknown>): void {
    this.write('fatal', message, context);
  }

  // --- internal ----------------------------------------------------------

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: epochNow(),
      level,
      message,
      service: this.service,
      correlationId: this.correlationId,
      context,
    };

    const jsonLine = JSON.stringify(entry) + '\n';

    // Console destination
    if (LOG_LEVEL_MAP[level] >= this.consoleLevel) {
      process.stdout.write(this.formatConsole(entry, jsonLine));
    }

    // File destination
    if (LOG_LEVEL_MAP[level] >= this.fileLevel) {
      this.ensureFileStream();
      if (this.writeStream) {
        this.writeStream.write(jsonLine);
      }
    }
  }

  /**
   * Ensure the log file stream exists and the directory hierarchy is created.
   */
  private ensureFileStream(): void {
    if (this.writeStream) return;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a' });

    // Handle errors on the write stream itself
    this.writeStream.on('error', (err) => {
      console.error('[Logger] Failed to write to log file:', err);
    });

    // Rotation
    this.writeStream.on('open', () => {
      void this.rotateIfNeeded();
    });
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.filePath).catch(() => null);
      if (!stat) return;
      const maxSizeBytes = this.maxLogSizeMB * 1024 * 1024;
      if (stat.size >= maxSizeBytes) {
        await this.rotate();
      }
    } catch {
      // ignore – race condition with concurrent writes is fine
    }
  }

  private async rotate(): Promise<void> {
    if (!this.writeStream) return;
    this.writeStream.end();

    // Shift existing rotated files: .1 → .2, .2 → .3 …
    for (let i = this.maxLogFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      try {
        await fs.promises.rename(from, to).catch(() => {}); // ignore if doesn't exist
      } catch {
        // ignore
      }
    }

    try {
      await fs.promises.rename(this.filePath, `${this.filePath}.1`);
    } catch {
      // already renamed or race – nothing to do
    }

    // Open a fresh write stream
    this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  // --- console formatting -----------------------------------------------

  private formatConsole(entry: LogEntry, _jsonLine: string): string {
    if (!this.colour) return this.formatPlain(entry);

    const levelStr = entry.level.toUpperCase().padEnd(5);
    const color = COLORS[entry.level] ?? '37';
    const ts = entry.timestamp.replace(/T/, ' ').slice(0, 23);
    const corr = entry.correlationId ? ` [${entry.correlationId}]` : '';
    const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : '';

    return `\x1b[${color}m${ts}\x1b[0m \x1b[${color}m[${levelStr}]\x1b[0m \x1b[90m${this.service}${corr}\x1b[0m ${entry.message}${ctx}\n`;
  }

  private formatPlain(entry: LogEntry): string {
    const ts = entry.timestamp.replace('T', ' ').slice(0, 23);
    const levelStr = entry.level.toUpperCase().padEnd(5);
    const corr = entry.correlationId ? ` [${entry.correlationId}]` : '';
    const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
    return `${ts} [${levelStr}] ${this.service}${corr} ${entry.message}${ctx}`;
  }

  // --- lifecycle --------------------------------------------------------

  /** Flush and close the file stream. Call during graceful shutdown. */
  close(): Promise<void> {
    if (!this.writeStream) return Promise.resolve();
    this.writeStream.end();
    return new Promise<void>((resolve) => {
      this.writeStream!.on('close', () => resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton – always use this instance from anywhere in the app
// ---------------------------------------------------------------------------

/**
 * Read per-destination log levels from environment variables.
 */
function buildOptions(): LoggerOptions {
  const consoleLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? DEFAULT_LOG_LEVEL;

  // Validate
  if (!LOG_LEVEL_MAP[consoleLevel]) {
    console.warn(`[Logger] Invalid LOG_LEVEL="${consoleLevel}", falling back to "${DEFAULT_LOG_LEVEL}"`);
  }

  const fileLevel = (process.env.LOG_FILE_LEVEL as LogLevel | undefined) ?? DEFAULT_FILE_LOG_LEVEL;
  if (!LOG_LEVEL_MAP[fileLevel]) {
    console.warn(`[Logger] Invalid LOG_FILE_LEVEL="${fileLevel}", falling back to "${DEFAULT_FILE_LOG_LEVEL}"`);
  }

  return {
    consoleLevel: LOG_LEVEL_MAP[consoleLevel] !== undefined ? consoleLevel : DEFAULT_LOG_LEVEL,
    fileLevel: LOG_LEVEL_MAP[fileLevel] !== undefined ? fileLevel : DEFAULT_FILE_LOG_LEVEL,
    filePath: process.env.LOG_FILE_PATH,
    maxLogFiles: process.env.LOG_MAX_FILES ? parseInt(process.env.LOG_MAX_FILES, 10) : undefined,
    maxLogSizeMB: process.env.LOG_MAX_SIZE_MB ? parseInt(process.env.LOG_MAX_SIZE_MB, 10) : undefined,
  };
}

export const logger = new Logger(buildOptions());