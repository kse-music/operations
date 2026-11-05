import fs from 'node:fs';

const minimumFreeBytes = 10n * 1024n ** 3n;

export function requireBuildSpace(directory) {
  const { bavail, bsize } = fs.statfsSync(directory, { bigint: true });
  const availableBytes = bavail * bsize;
  if (availableBytes < minimumFreeBytes) {
    const freeGiB = (Number(availableBytes) / 1024 ** 3).toFixed(1);
    throw new Error(
      `构建已停止：${directory} 所在磁盘仅剩 ${freeGiB} GiB，至少需要 10 GiB。请先确认没有构建在运行，再清理可重建的编译缓存；不要删除用户数据。`,
    );
  }
}
