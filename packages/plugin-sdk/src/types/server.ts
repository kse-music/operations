export const serverSections = [
  { key: 'overview', label: '资源概览' },
  { key: 'disks', label: '磁盘' },
  { key: 'network', label: '网络' },
  { key: 'containers', label: 'Docker 容器' },
  { key: 'images', label: '镜像' },
  { key: 'processes', label: '进程' },
  { key: 'ports', label: '监听端口' },
  { key: 'services', label: 'systemd 服务' },
  { key: 'logs', label: '日志' },
] as const;
export type ServerSection = (typeof serverSections)[number]['key'];
export type MonitorSection = 'overview' | 'disks' | 'network';
export type OperationsSection = Exclude<ServerSection, MonitorSection>;
export function isMonitorSection(section: ServerSection): section is MonitorSection {
  return section === 'overview' || section === 'disks' || section === 'network';
}
