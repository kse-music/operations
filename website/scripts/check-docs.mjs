import { fileURLToPath } from 'node:url';
import { verifySite } from './documentation.mjs';
import { siteOrigin } from './site-config.mjs';

const result = await verifySite(
  fileURLToPath(new URL('../dist/', import.meta.url)),
  fileURLToPath(new URL('../documentation/', import.meta.url)),
  siteOrigin,
);
console.log(
  `校验通过：${result.pages} 个 HTML、${result.documentationPages} 篇文档、${result.references} 篇 SDK 规范；站内链接、锚点、静态资源与站点地图完整。`,
);
