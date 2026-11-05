export const serverSections = [
  { key: 'containers', label: 'Docker 容器' },
  { key: 'images', label: '镜像' },
] as const;
export type ServerSection = (typeof serverSections)[number]['key'];
export type OperationsSection = ServerSection;
