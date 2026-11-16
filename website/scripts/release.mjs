const repository = 'https://github.com/kse-music/operations';
export function parseRelease(input) {
  if (!input || typeof input !== 'object' || input.draft !== false || input.prerelease !== false)
    throw new Error('必须使用已公开的正式 Release。');
  if (typeof input.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(input.tag_name))
    throw new Error('Release 标签必须是正式版本 vX.Y.Z。');
  const version = input.tag_name.slice(1);
  const url = `${repository}/releases/tag/${input.tag_name}`;
  if (input.html_url !== url || !Number.isFinite(Date.parse(input.published_at)))
    throw new Error('Release 来源或发布时间无效。');
  const name = `ServerDeck_${version}_x64-setup.exe`;
  const assetBase = `${repository}/releases/download/${input.tag_name}/`;
  const asset = input.assets?.find((item) => item.name === name);
  const signature = input.assets?.find((item) => item.name === `${name}.sig`);
  if (
    !asset ||
    !signature ||
    asset.browser_download_url !== `${assetBase}${name}` ||
    signature.browser_download_url !== `${assetBase}${name}.sig` ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !Number.isSafeInteger(signature.size) ||
    signature.size <= 0
  )
    throw new Error('缺少匹配当前版本的官方 Windows 安装包或签名。');
  return {
    version,
    publishedAt: input.published_at,
    url,
    downloadUrl: asset.browser_download_url,
    signatureUrl: signature.browser_download_url,
    size: asset.size,
  };
}
