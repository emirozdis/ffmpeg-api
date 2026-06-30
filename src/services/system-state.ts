import os from 'os';
import { systemDetector } from './system-detector';
import { systemHealth } from './system-health';
import { loadMonitor } from './load-monitor';
import { metricsRecorder } from './metrics-recorder';

/** Aggregator that pulls together state from all sub-modules. */
class SystemState {
  get hardware() {
    return systemDetector.hardware;
  }

  get healthChecks() {
    return systemHealth.checks;
  }

  get overallHealth() {
    return systemHealth.overallHealth;
  }

  get healthSummary() {
    return systemHealth.getHealth();
  }

  get currentConcurrency() {
    return loadMonitor.concurrency;
  }

  get metrics() {
    const m = metricsRecorder.getMetrics();
    m.currentConcurrency = loadMonitor.concurrency;
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
