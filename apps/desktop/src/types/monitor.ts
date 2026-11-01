export interface CpuUsage {
  name: string;
  usage: number | null;
  iowait: number | null;
}
export interface Memory {
  total: number;
  used: number;
  available: number;
  usage: number;
  approximate: boolean;
  swapTotal: number;
  swapUsed: number;
  swapUsage: number | null;
}
export interface Disk {
  mount: string;
  source: string;
  filesystem: string;
  device: string;
  pseudo: boolean;
  image: boolean;
  container: boolean;
  duplicateOf: string | null;
  total: number | null;
  used: number | null;
  available: number | null;
  usage: number | null;
  error: string | null;
}
export interface NetworkInterface {
  name: string;
  index: number | null;
  addresses: string[];
  received: number;
  sent: number;
  receiveRate: number | null;
  sendRate: number | null;
}
export interface Sample {
  sampledAt: number;
  uptime: number | null;
  load: [number, number, number] | null;
  cpus: CpuUsage[];
  memory: Memory | null;
  disks: Disk[];
  network: NetworkInterface[];
  warnings: string[];
  rateStatus: string;
  system: {
    hostname: string | null;
    distribution: string | null;
    kernel: string | null;
    architecture: string | null;
    cpuModel: string | null;
    cores: number | null;
    systemTime: string | null;
    timezone: string | null;
  };
}
export interface HistoryPoint {
  sampledAt: number;
  uptime: number | null;
  cpu: number | null;
  memory: number | null;
  receiveRate: number | null;
  sendRate: number | null;
}
export interface MonitorSnapshot {
  hostId: string;
  sessionId: string;
  revision: number;
  state: string;
  intervalSecs: number;
  error: string | null;
  sample: Sample | null;
  history: HistoryPoint[];
}
export const monitorLabels: Record<string, string> = {
  connecting: '连接中',
  sampling: '正在采集',
  running: '采样正常',
  partial: '部分指标不可用',
  paused: '已暂停',
  failed: '连接已结束',
  error: '采集失败，旧值已过期',
};
export function percent(value: number | null | undefined): string {
  return value == null ? '待计算' : `${value.toFixed(1)}%`;
}
