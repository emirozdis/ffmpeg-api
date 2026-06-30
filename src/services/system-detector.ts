import os from 'os';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { SystemHardware, CpuInfo, RamInfo, GpuInfo, FfmpegInfo, GpuType } from '../types';

// ---------------------------------------------------------------------------
// Detection helpers (synchronous)
// ---------------------------------------------------------------------------

function detectCpu(): CpuInfo {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? 'Unknown';
  const speedMhz = Math.round(cpus[0]?.speed ?? 0);
  const logicalCores = cpus.length;

  // Physical cores estimation: on macOS arm64 (Apple Silicon), logical = physical.
  // On x86_64 with HyperThreading, physical = logical / 2.
  const physicalCores = os.arch() === 'arm64' ? logicalCores : Math.max(1, Math.ceil(logicalCores / 2));

  return { model, logicalCores, physicalCores, speedMhz };
}

function detectRam(): RamInfo {
  const total = os.totalmem();
  const available = os.freemem();
  return {
    total,
    available,
    totalGigabytes: Math.round(total / 1024 / 1024 / 1024),
    availableGigabytes: Math.round(available / 1024 / 1024 / 1024),
  };
}

function detectFfmpeg(): FfmpegInfo {
  let version = 'unknown';
  let ffprobeVersion = 'unknown';
  let installed = false;
  let ffprobeInstalled = false;

  try {
    const ffmpegVer = execSync('ffmpeg -version 2>&1 | head -1', { encoding: 'utf8', timeout: 5000 });
    version = ffmpegVer.match(/version (\S+)/)?.[1] ?? 'installed';
    installed = true;
  } catch {
    installed = false;
  }

  try {
    const ffprobeVer = execSync('ffprobe -version 2>&1 | head -1', { encoding: 'utf8', timeout: 5000 });
    ffprobeVersion = ffprobeVer.match(/version (\S+)/)?.[1] ?? 'installed';
    ffprobeInstalled = true;
  } catch {
    ffprobeInstalled = false;
  }

  return { version, ffprobeVersion, installed, ffprobeInstalled };
}

function detectGpu(ffmpegInstalled: boolean): GpuInfo {
  if (!ffmpegInstalled) {
    return { type: 'none', available: false, h264Encoders: [], hevcEncoders: [], aacEncoders: [] };
  }

  try {
    const encoders = execSync('ffmpeg -encoders 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const lines = encoders.split('\n').map((l) => l.trim().split(/\s+/)).filter(Boolean);

    const h264Encoders: string[] = [];
    const hevcEncoders: string[] = [];
    const aacEncoders: string[] = [];
    let gpuType: GpuType = 'none';

    for (const parts of lines) {
      const name = parts[1];
      if (!name) continue;

      if (name.includes('videotoolbox')) {
        h264Encoders.push(name);
        hevcEncoders.push(name);
        gpuType = gpuType === 'none' ? 'videotoolbox' : gpuType;
      }
      if (name.includes('nvenc')) {
        h264Encoders.push(name);
        hevcEncoders.push(name);
        aacEncoders.push(name);
        gpuType = gpuType === 'none' ? 'nvenc' : gpuType;
      }
      if (name.includes('vaapi') || name.includes('v4l2')) {
        h264Encoders.push(name);
        hevcEncoders.push(name);
        gpuType = gpuType === 'none' ? 'vaapi' : gpuType;
      }
      if (name.includes('qsv')) {
        h264Encoders.push(name);
        hevcEncoders.push(name);
        gpuType = gpuType === 'none' ? 'qsv' : gpuType;
      }
    }

    return {
      type: gpuType,
      available: gpuType !== 'none',
      h264Encoders: h264Encoders.length > 0 ? h264Encoders : ['libx264'],
      hevcEncoders: hevcEncoders.length > 0 ? hevcEncoders : [],
      aacEncoders: aacEncoders.length > 0 ? aacEncoders : ['aac'],
    };
  } catch {
    return { type: 'none', available: false, h264Encoders: [], hevcEncoders: [], aacEncoders: [] };
  }
}

function detectPlatform(): SystemHardware['platform'] {
  return {
    os: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptimeSeconds: Math.round(os.uptime()),
  };
}

// ---------------------------------------------------------------------------
// SystemDetector class
// ---------------------------------------------------------------------------

export class SystemDetector {
  private _hardware: SystemHardware;

  constructor() {
    const ffmpegInfo = detectFfmpeg();
    const gpuInfo = detectGpu(ffmpegInfo.installed);
    const cpuInfo = detectCpu();
    const ramInfo = detectRam();
    const platformInfo = detectPlatform();

    this._hardware = { cpu: cpuInfo, ram: ramInfo, gpu: gpuInfo, ffmpeg: ffmpegInfo, platform: platformInfo };

    logger.debug('Hardware detection complete', {
      cpu: `${cpuInfo.model} (${cpuInfo.logicalCores} cores)`,
      ram: `${ramInfo.totalGigabytes}GB total, ${ramInfo.availableGigabytes}GB free`,
      gpu: gpuInfo.available ? gpuInfo.type : 'none (CPU only)',
      ffmpeg: ffmpegInfo.version,
      ffprobe: ffmpegInfo.ffprobeVersion,
    });
  }

  /** Read-only access to detected hardware. */
  get hardware(): SystemHardware {
    return this._hardware;
  }

  /** Re-run detection. Useful for debugging or on-demand refresh. */
  refresh(): SystemHardware {
    const ffmpegInfo = detectFfmpeg();
    const gpuInfo = detectGpu(ffmpegInfo.installed);
    this._hardware = {
      ...this._hardware,
      cpu: detectCpu(),
      ram: detectRam(),
      gpu: gpuInfo,
      ffmpeg: ffmpegInfo,
      platform: detectPlatform(),
    };
    return this._hardware;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const systemDetector = new SystemDetector();