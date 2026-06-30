import os from 'os';
import { systemDetector } from './system-detector';
import { healthChecker } from './system-health';
import { loadMonitor } from './load-monitor';
import { metricsRecorder } from './metrics-recorder';

/** Aggregator that pulls together state from all sub-modules. */
class SystemState {
  get hardware() {
    return systemDetector.hardware;
  }

  get healthChecks() {
    return healthChecker.checksResult;
  }

  get overallHealth() {
    return healthChecker.health.status;
  }

  get healthSummary() {
    return healthChecker.health;
  }

  get currentConcurrency() {
    return loadMonitor.getConcurrency();
  }

  get metrics() {
    const m = metricsRecorder.getMetrics();
    m.currentConcurrency = loadMonitor.getConcurrency();
    return m;
  }

  get systemSnapshot() {
    const cpus = os.cpus().length;
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      cpuUsagePct: cpus > 0 ? parseFloat(((loadAvg[0] / cpus) * 100).toFixed(1)) : 0,
      memoryUsagePct: parseFloat((((totalMem - freeMem) / totalMem) * 100).toFixed(1)),
      loadAvg: [loadAvg[0], loadAvg[1], loadAvg[2]],
      freeMemoryBytes: freeMem,
      totalMemoryBytes: totalMem,
    };
  }
}

export const systemState = new SystemState();