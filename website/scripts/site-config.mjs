export const siteOrigin = process.env.WEBSITE_ORIGIN || 'https://ops.hiboot.cn';
const origin = new URL(siteOrigin);
if (origin.protocol !== 'https:' || origin.origin !== siteOrigin) {
  throw new Error('WEBSITE_ORIGIN 必须为无路径的 HTTPS 站点源。');
}
