/**
 * L1 pull URL + device token.
 * Prefer env; optional local file ~/.config/mastra-l2/device.json { "l1Url", "token", "intervalMs" }.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type L2Config = {
  l1Url: string;
  token: string;
  intervalMs: number;
  harness?: string;
  deviceId?: string;
};

export function devicePath() {
  return join(homedir(), '.config', 'mastra-l2', 'device.json');
}

function fromFile(): Partial<L2Config> {
  const p = devicePath();
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return {
      l1Url: typeof j.l1Url === 'string' ? j.l1Url : undefined,
      token: typeof j.token === 'string' ? j.token : undefined,
      intervalMs: typeof j.intervalMs === 'number' ? j.intervalMs : undefined,
      harness: typeof j.harness === 'string' ? j.harness : undefined,
      deviceId: typeof j.deviceId === 'string' ? j.deviceId : undefined,
    };
  } catch {
    return {};
  }
}

export function loadConfig(): L2Config {
  const file = fromFile();
  const l1Url = String(process.env.L1_PULL_URL || file.l1Url || 'http://localhost:4120').replace(/\/$/, '');
  // 设备身份优先（multi-device）：L2_DEVICE_TOKEN 是配对换来的设备凭据；PUSH_TOKEN 为共享老路径
  const token = String(process.env.L2_DEVICE_TOKEN || process.env.PUSH_TOKEN || file.token || '');
  const intervalMs = Number(process.env.L2_PULL_INTERVAL_MS || file.intervalMs || 2000);
  const harness = String(process.env.L2_HARNESS || file.harness || '') || undefined;
  const deviceId = String(process.env.L2_DEVICE_ID || file.deviceId || '') || undefined;
  if (!token) throw new Error('Missing L2_DEVICE_TOKEN / PUSH_TOKEN (or ~/.config/mastra-l2/device.json token)');
  return { l1Url, token, intervalMs, harness, deviceId };
}

/** 读设备默认 harness（UI 设为默认写入 device.json 后，claim loop 据此重报 L1）。 */
export function readDeviceHarness(): string | undefined {
  return fromFile().harness;
}

export function saveConfig(cfg: L2Config) {
  const dir = join(homedir(), '.config', 'mastra-l2');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const merged = { ...fromFile(), l1Url: cfg.l1Url, token: cfg.token, intervalMs: cfg.intervalMs, ...(cfg.harness ? { harness: cfg.harness } : {}), ...(cfg.deviceId ? { deviceId: cfg.deviceId } : {}) };
  writeFileSync(devicePath(), JSON.stringify(merged, null, 2), {
    mode: 0o600,
  });
}
