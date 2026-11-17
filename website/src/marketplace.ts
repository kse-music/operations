export const pluginCategories = [
  '全部插件',
  'AI 助手',
  '容器与编排',
  '数据库',
  '监控与日志',
  '开发工具',
] as const;
export type PluginCategory = (typeof pluginCategories)[number];
export type PluginSort = 'recommended' | 'updated' | 'name';
export type PluginIcon =
  'docker' | 'assistant' | 'redis' | 'database' | 'nginx' | 'logs' | 'kubernetes' | 'shield';

export interface MarketplacePlugin {
  id: string;
  name: string;
  category: Exclude<PluginCategory, '全部插件'>;
  description: string;
  tags: string[];
  author: string;
  version: string;
  updatedAt: string;
  icon: PluginIcon;
  featured?: boolean;
}

// Display-only catalog. Downloads stay disabled at the interaction boundary.
export const marketplacePlugins: MarketplacePlugin[] = [
  {
    id: 'docker',
    name: 'Docker 工作台',
    category: '容器与编排',
    description: '容器、镜像与 Compose 项目，一站管理。',
    tags: ['容器管理', 'Compose'],
    author: 'ServerDeck',
    version: '1.6.0',
    updatedAt: '2026-11-12',
    icon: 'docker',
    featured: true,
  },
  {
    id: 'assistant',
    name: 'AI 运维助手',
    category: 'AI 助手',
    description: '让 AI 理解主机上下文，协助分析与执行。',
    tags: ['AI 助手', '自动化'],
    author: 'ServerDeck',
    version: '1.3.2',
    updatedAt: '2026-11-10',
    icon: 'assistant',
    featured: true,
  },
  {
    id: 'redis',
    name: 'Redis 管理',
    category: '数据库',
    description: '键值浏览、命令执行与运行状态，快速定位缓存问题。',
    tags: ['键值浏览', '性能分析'],
    author: '社区开发者',
    version: '1.2.0',
    updatedAt: '2026-11-14',
    icon: 'redis',
  },
  {
    id: 'postgresql',
    name: 'PostgreSQL 管理',
    category: '数据库',
    description: '连接数据库，浏览表结构，轻松执行常用查询。',
    tags: ['SQL 查询', '数据管理'],
    author: '社区开发者',
    version: '1.1.0',
    updatedAt: '2026-11-08',
    icon: 'database',
  },
  {
    id: 'nginx',
    name: 'Nginx 管理',
    category: '开发工具',
    description: '配置检查、站点管理与访问日志，常用操作触手可及。',
    tags: ['站点配置', '日志'],
    author: '社区开发者',
    version: '1.0.4',
    updatedAt: '2026-11-06',
    icon: 'nginx',
  },
  {
    id: 'logs',
    name: '日志查看器',
    category: '监控与日志',
    description: '实时跟踪远程日志，按关键词筛选关键线索。',
    tags: ['实时日志', '关键词过滤'],
    author: '社区开发者',
    version: '1.3.0',
    updatedAt: '2026-11-05',
    icon: 'logs',
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes 工具箱',
    category: '容器与编排',
    description: '查看集群资源与 Pod 状态，集中处理日常排障。',
    tags: ['集群资源', 'Pod 终端'],
    author: '社区开发者',
    version: '0.8.2',
    updatedAt: '2026-11-03',
    icon: 'kubernetes',
  },
  {
    id: 'certificates',
    name: '证书管家',
    category: '开发工具',
    description: '查看证书信息与到期时间，及时发现 HTTPS 配置风险。',
    tags: ['SSL 证书', '到期检查'],
    author: '社区开发者',
    version: '1.0.1',
    updatedAt: '2026-11-01',
    icon: 'shield',
  },
];

export function filterPlugins(
  query: string,
  category: PluginCategory,
  sort: PluginSort,
): MarketplacePlugin[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = marketplacePlugins.filter((plugin) => {
    const text = [plugin.name, plugin.description, plugin.author, plugin.category, ...plugin.tags]
      .join(' ')
      .toLocaleLowerCase();
    return (
      (category === '全部插件' || plugin.category === category) &&
      terms.every((term) => text.includes(term))
    );
  });
  if (sort === 'updated') matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (sort === 'name') matches.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return matches;
}
