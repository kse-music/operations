export interface ConfigMount {
  Type?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}
export interface ConfigLocation {
  path: string;
  writable: boolean;
  message: string;
}
export function configLocation(path: string, mounts?: ConfigMount[]): ConfigLocation {
  if (
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('请填写不含 . 或 .. 的绝对配置路径');
  if (!mounts) return { path, writable: true, message: '' };
  const mount = mounts
    .filter(
      (m) =>
        m.Type === 'bind' &&
        m.Source?.startsWith('/') &&
        m.Destination?.startsWith('/') &&
        (path === m.Destination || path.startsWith(m.Destination.replace(/\/+$/, '') + '/')),
    )
    .sort((a, b) => b.Destination!.length - a.Destination!.length)[0];
  if (!mount)
    throw new Error(
      '该配置没有绑定到服务器目录。请先将 Nginx 配置目录以 bind mount 挂载，再从此处读取和编辑。',
    );
  const suffix = path.slice(mount.Destination!.replace(/\/+$/, '').length);
  return {
    path: mount.Source!.replace(/\/+$/, '') + suffix,
    writable: mount.RW === true && suffix.length > 0,
    message: !suffix
      ? '单文件绑定仅支持读取。请挂载配置目录后编辑，避免原子替换后容器继续使用旧文件。'
      : mount.RW !== true
        ? '此挂载为只读，配置不能保存。'
        : '',
  };
}
