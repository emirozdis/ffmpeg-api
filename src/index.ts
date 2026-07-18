import app from './app';
import { config } from './config/env';
import { logger } from './utils/logger';
import { systemDetector } from './services/system-detector';
import { loadMonitor } from './services/load-monitor';
import { metricsRecorder } from './services/metrics-recorder';

/**
 * Compiles and prints diagnostic variables to the logs.
 */
const startDiagnostics = () => {
  const hw = systemDetector.hardware;
  const apiVersion = '1.0.0'; // Aligns with package.json definitions
  const consoleLevel = logger.getConsoleLevel();
  const fileLevel = logger.getFileLevel();
  const logPath = logger.getLogFilePath();

  const ffmpegStatus = hw.ffmpeg.installed ? hw.ffmpeg.version : 'NOT INSTALLED';
  const ffprobeStatus = hw.ffmpeg.ffprobeInstalled ? hw.ffmpeg.ffprobeVersion : 'NOT INSTALLED';
  const gpuStatus = hw.gpu.available ? `${hw.gpu.type} (Hardware acceleration available)` : 'none (CPU only)';

  logger.info('========================================================================');
  logger.info('🚀 MyTurn Video Pipeline Service is starting up...');
  logger.info('========================================================================');
  logger.info(` • API Version : ${apiVersion}`);
  logger.info(` • Log Levels  : Console [${consoleLevel}] / File [${fileLevel} -> ${logPath}]`);
  logger.info(` • OS Platform : ${hw.platform.os} (${hw.platform.arch})`);
  logger.info(` • CPU Model   : ${hw.cpu.model}`);
  logger.info(` • CPU Cores   : ${hw.cpu.physicalCores} Physical / ${hw.cpu.logicalCores} Logical @ ${hw.cpu.speedMhz}Mhz`);
  logger.info(` • System RAM  : ${hw.ram.totalGigabytes} GB Total (${hw.ram.availableGigabytes} GB Free)`);
  logger.info(` • GPU Device  : ${gpuStatus}`);
  logger.info(` • FFmpeg      : ${ffmpegStatus}`);
  logger.info(` • FFprobe     : ${ffprobeStatus}`);
  logger.info('========================================================================');
};

const server = app.listen(config.PORT, () => {
  // Initialize start metrics benchmark timestamp
  metricsRecorder.setTotalStartTime(Date.now());

  // Print structured diagnostics profile on startup
  startDiagnostics();

  // Start the background load balancer
  loadMonitor.start();

  logger.info(`Video Pipeline Service is running on http://localhost:${config.PORT}`, { port: config.PORT });
  logger.debug(`Uploads dir: ${config.UPLOAD_DIR}`, { dir: config.UPLOAD_DIR });
  logger.debug(`Processed dir: ${config.PROCESSED_DIR}`, { dir: config.PROCESSED_DIR });
  logger.debug(`State dir: ${config.STATE_DIR}`, { dir: config.STATE_DIR });
});

// --- Graceful Shutdown ---

const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // Stop load monitor loops
  loadMonitor.stop();

  // Close the HTTP server
  server.close(() => {
    logger.info('HTTP server closed.');
    // Close the logger (flushes file stream)
    void logger.close().then(() => {
      logger.info('Logger closed. Exiting.');
      process.exit(0);
    });
  });

  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    logger.error('Forced shutdown: timeout reached');
    process.exit(1);
  }, 10_000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
