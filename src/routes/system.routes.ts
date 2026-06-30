import { Router } from 'express';
import { requireApiKey } from '../middlewares/auth.middleware';
import { systemDetector } from '../services/system-detector';
import { healthChecker } from '../services/system-health';
import { loadMonitor } from '../services/load-monitor';
import { metricsRecorder } from '../services/metrics-recorder';
import os from 'os';
import { logger } from '../utils/logger';

const router = Router();

// Apply API Key Authentication to all system routes
router.use(requireApiKey);

// --- GET /api/v1/system/health -------------------------------------------

router.get('/health', (_req, res) => {
  logger.debug('Health check requested', { ip: _req.ip });
  const { status, message } = healthChecker.health;
  const checks = healthChecker.checksResult;

  const httpStatus = status === 'CRITICAL' ? 503 : 200;
  res.status(httpStatus).json({
    status: status.toLowerCase(),
    message,
    checks,
    timestamp: new Date().toISOString(),
  });
});

// --- GET /api/v1/system --------------------------------------------------

router.get('/', (_req, res) => {
  logger.debug('System info requested', { ip: _req.ip });

  const hardware = systemDetector.hardware;
  const loadAvg = os.loadavg();
  const cpuUsage = (loadAvg[0] / hardware.cpu.logicalCores) * 100;
  const memUsagePct = ((1 - os.freemem() / os.totalmem()) * 100);

  const { status, message } = healthChecker.health;

  res.json({
    status: 'success',
    data: {
      hardware: {
        cpu: hardware.cpu,
        ram: hardware.ram,
        gpu: hardware.gpu,
        ffmpeg: hardware.ffmpeg,
        platform: hardware.platform,
      },
      system: {
        currentConcurrency: loadMonitor.getConcurrency(),
        cpuUsagePct: Math.round(cpuUsage * 10) / 10,
        memoryUsagePct: Math.round(memUsagePct * 10) / 10,
        loadAvg: loadAvg,
        freeMemoryBytes: os.freemem(),
        uptimeSeconds: os.uptime(),
      },
      health: {
        status,
        message,
      },
    },
  });
});

// --- GET /api/v1/system/metrics ------------------------------------------

router.get('/metrics', (_req, res) => {
  logger.debug('Metrics requested', { ip: _req.ip });

  const metrics = metricsRecorder.getMetrics();
  metrics.currentConcurrency = loadMonitor.getConcurrency();

  res.json({
    status: 'success',
    data: metrics,
  });
});

export default router;
