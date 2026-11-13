import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import ImageArchiveDialog from './ImageArchiveDialog.vue';
const api = vi.hoisted(() => ({
  pick: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  inspect: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('@serverdeck/plugin-sdk/transport', () => ({ request: api.notify }));
vi.mock('@serverdeck/plugin-sdk/local-files', () => ({ pickLocalFiles: api.pick }));
vi.mock('@serverdeck/plugin-sdk/actions', () => ({ cancelCurrent: api.cancel }));
vi.mock('@serverdeck/plugin-sdk/context', () => ({
  usePlatformContext: () => ({
    hosts: [
      { id: 'host', name: 'Source', hostname: 'source', port: 22, username: 'ops' },
      { id: 'target', name: 'Target', hostname: 'target', port: 22, username: 'ops' },
      { id: 'other', name: 'Other', hostname: 'other', port: 22, username: 'ops' },
    ],
  }),
}));
vi.mock('./image-archive', async (original) => ({
  ...(await original<typeof import('./image-archive')>()),
  runImageArchive: api.run,
  inspectImageTarget: api.inspect,
}));
let app: App | undefined;
let root: HTMLDivElement;
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await nextTick();
};
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
function mount(row?: Record<string, unknown>, remoteTransfer = false) {
  api.cancel.mockResolvedValue(undefined);
  api.notify.mockResolvedValue(undefined);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  root = document.createElement('div');
  document.body.append(root);
  const completed = vi.fn();
  app = createApp(ImageArchiveDialog, {
    hostId: 'host',
    hostLabel: 'QA (192.0.2.1)',
    visible: true,
    row,
    remoteTransfer,
    onCompleted: completed,
  });
  app.mount(root);
  return completed;
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  )!;
afterEach(() => {
  app?.unmount();
  root?.remove();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const image = { ID: `sha256:${'a'.repeat(64)}`, Repository: 'app', Tag: 'v1' };
async function selectTarget(value = 'target') {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="目标主机"]')!;
  select.value = value;
  select.dispatchEvent(new Event('change'));
  await settle();
}
it('requires a different target host and starts relay plus import without choosing a local file', async () => {
  api.inspect.mockResolvedValue(null);
  api.run.mockResolvedValue(undefined);
  const completed = mount(image, true);
  await settle();
  expect(button('传输并导入').disabled).toBe(true);
  expect(
    [...document.querySelectorAll('select option')].map(
      (option) => (option as HTMLOptionElement).value,
    ),
  ).toEqual(['', 'target', 'other']);
  await selectTarget();
  button('传输并导入').click();
  await settle();
  expect(api.inspect).toHaveBeenCalledWith('target', 'app:v1', expect.any(AbortSignal));
  expect(api.run).toHaveBeenCalledWith(
    'host',
    {
      kind: 'transfer',
      id: image.ID,
      reference: 'app:v1',
      fileName: 'app-v1-aaaaaaaaaaaa.tar',
      targetHostId: 'target',
      expectedTargetId: null,
      replaceConfirmed: false,
      confirmed: true,
    },
    '',
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(api.pick).not.toHaveBeenCalled();
  expect(completed).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('镜像已传输并导入目标主机');
});
it('requires explicit confirmation for the actual conflicting tag and resets it on target change', async () => {
  const conflicting = `sha256:${'b'.repeat(64)}`;
  api.inspect.mockResolvedValue(conflicting);
  api.run.mockResolvedValue(undefined);
  mount(image, true);
  await selectTarget();
  button('传输并导入').click();
  await settle();
  expect(api.run).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(`目标已有标签 app:v1，当前指向 ${conflicting}`);
  expect(button('确认替换并传输')).toBeDefined();
  await selectTarget('other');
  expect(document.body.textContent).not.toContain('目标已有标签');
  button('传输并导入').click();
  await settle();
  expect(api.inspect).toHaveBeenCalledTimes(2);
  expect(api.run).not.toHaveBeenCalled();
  button('确认替换并传输').click();
  await settle();
  expect(api.run.mock.calls[0]?.[1]).toMatchObject({
    targetHostId: 'other',
    expectedTargetId: conflicting,
    replaceConfirmed: true,
  });
});
it('keeps an identical target tag without requesting replacement confirmation', async () => {
  api.inspect.mockResolvedValue(image.ID);
  api.run.mockResolvedValue(undefined);
  mount(image, true);
  await selectTarget();
  button('传输并导入').click();
  await settle();
  expect(api.run.mock.calls[0]?.[1]).toMatchObject({
    expectedTargetId: image.ID,
    replaceConfirmed: false,
  });
});
it('does not export when the target cannot be inspected and displays the failure', async () => {
  api.inspect.mockRejectedValue(new Error('target Docker unavailable'));
  mount(image, true);
  await selectTarget();
  button('传输并导入').click();
  await settle();
  expect(api.run).not.toHaveBeenCalled();
  expect(api.notify).toHaveBeenCalledExactlyOnceWith('ui.notify', {
    message: 'target Docker unavailable',
    error: true,
  });
  expect(document.body.textContent).not.toContain('target Docker unavailable');
  expect(document.body.textContent).toContain('镜像任务失败');
});
it('cancels an active relay and never reports it as completed', async () => {
  api.inspect.mockResolvedValue(null);
  let signal: AbortSignal | undefined;
  api.run.mockImplementation((_host, _request, _path, inputSignal: AbortSignal) => {
    signal = inputSignal;
    return new Promise((_resolve, reject) =>
      inputSignal.addEventListener('abort', () => reject(new Error('任务已取消'))),
    );
  });
  const completed = mount(image, true);
  await selectTarget();
  button('传输并导入').click();
  await settle();
  button('取消任务').click();
  await settle();
  expect(signal?.aborted).toBe(true);
  expect(api.cancel).toHaveBeenCalledOnce();
  expect(completed).not.toHaveBeenCalled();
  expect(api.notify).toHaveBeenCalledWith('ui.notify', { message: '任务已取消', error: true });
  expect(document.body.textContent).not.toContain('任务已取消');
});
it('requires a local archive selection and submits upload then load for the fixed host', async () => {
  api.pick.mockResolvedValue(['C:/images/image.tar']);
  api.run.mockResolvedValue(undefined);
  const completed = mount();
  await settle();
  expect(button('上传并导入').disabled).toBe(true);
  expect(document.body.textContent).toContain('同名标签可能被替换');
  button('选择…').click();
  await settle();
  button('上传并导入').click();
  await settle();
  expect(api.pick).toHaveBeenCalledWith('files');
  expect(api.run).toHaveBeenCalledWith(
    'host',
    { kind: 'import', fileName: 'image.tar', confirmed: true },
    'C:/images/image.tar',
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(completed).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('镜像导入完成');
});
it('exports a selected image to a chosen local folder and editable tar filename', async () => {
  api.pick.mockResolvedValue(['C:/exports']);
  api.run.mockResolvedValue(undefined);
  mount({ ID: 'a'.repeat(64), Repository: 'registry:5000/app', Tag: 'v1' });
  await settle();
  button('选择…').click();
  await settle();
  const name = document.querySelector<HTMLInputElement>('[aria-label="文件名（.tar）"]')!;
  name.value = 'custom.tar';
  name.dispatchEvent(new Event('input'));
  await settle();
  button('导出').click();
  await settle();
  expect(api.pick).toHaveBeenCalledWith('folder');
  expect(api.run).toHaveBeenCalledWith(
    'host',
    {
      kind: 'export',
      id: 'a'.repeat(64),
      reference: 'registry:5000/app:v1',
      fileName: 'custom.tar',
      confirmed: true,
    },
    'C:/exports/custom.tar',
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(document.body.textContent).toContain('镜像已导出到：C:/exports/custom.tar');
});

it.each(['import', 'export'] as const)(
  'displays ordinary local paths for image %s while passing the original to the transfer',
  async (kind) => {
    const path = kind === 'import' ? '\\\\?\\C:\\images\\image.tar' : '\\\\?\\UNC\\server\\share';
    api.pick.mockResolvedValue([path]);
    api.run.mockResolvedValue(undefined);
    mount(kind === 'export' ? { ID: 'a'.repeat(64), Repository: 'app', Tag: 'v1' } : undefined);
    await settle();
    button('选择…').click();
    await settle();
    const field = document.querySelector<HTMLInputElement>(
      `[aria-label="${kind === 'export' ? '本机保存目录' : '本机镜像归档'}"]`,
    )!;
    expect(field.value).toBe(kind === 'import' ? 'C:\\images\\image.tar' : '\\\\server\\share');
    if (kind === 'export') {
      const name = document.querySelector<HTMLInputElement>('[aria-label="文件名（.tar）"]')!;
      name.value = 'custom.tar';
      name.dispatchEvent(new Event('input'));
      await settle();
    }
    button(kind === 'export' ? '导出' : '上传并导入').click();
    await settle();
    expect(api.run.mock.calls[0]![2]).toBe(kind === 'import' ? path : `${path}/custom.tar`);
    expect(document.body.textContent).not.toContain('\\\\?\\');
    if (kind === 'export')
      expect(document.body.textContent).toContain('镜像已导出到：\\\\server\\share/custom.tar');
  },
);

it.each(['import', 'export'] as const)(
  'shows %s progress in decimal MB and MB/s without another dialog',
  async (kind) => {
    api.pick.mockResolvedValue(kind === 'import' ? ['C:/image.tar'] : ['C:/exports']);
    let finish: () => void = () => {};
    api.run.mockImplementation((_host, _request, _path, _signal, update) => {
      update({
        stage: kind === 'import' ? 'uploading' : 'downloading',
        output: '',
        transfer: {
          id: 'copy',
          state: 'running',
          transferredBytes: 29_723_852,
          totalBytes: 427_621_376,
          bytesPerSecond: 9_889_917,
          sha256: null,
          message: null,
          recoveryPaths: [],
        },
      });
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    mount(
      kind === 'export' ? { ID: 'a'.repeat(64), Repository: 'image', Tag: 'latest' } : undefined,
    );
    await settle();
    button('选择…').click();
    await settle();
    button(kind === 'export' ? '导出' : '上传并导入').click();
    await settle();
    expect(document.body.textContent).toContain('29.72 / 427.62 MB · 9.89 MB/s');
    expect(document.body.textContent).not.toContain('字节/秒');
    expect(document.querySelectorAll('dialog')).toHaveLength(1);
    finish();
    await settle();
  },
);

it.each(['import', 'export'] as const)(
  'stops showing %s transfer speed at full bytes and exposes verification and cleanup',
  async (kind) => {
    api.pick.mockResolvedValue(kind === 'import' ? ['C:/image.tar'] : ['C:/exports']);
    let publish: (value: unknown) => void = () => {};
    let finish: () => void = () => {};
    api.run.mockImplementation((_host, _request, _path, _signal, update) => {
      publish = update;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const completed = mount(
      kind === 'export' ? { ID: 'a'.repeat(64), Repository: 'image', Tag: 'latest' } : undefined,
    );
    await settle();
    button('选择…').click();
    await settle();
    button(kind === 'export' ? '导出' : '上传并导入').click();
    await settle();
    publish({
      stage: 'verifying',
      output: '',
      transfer: {
        state: 'verifying',
        totalBytes: 427_621_376,
        transferredBytes: 427_621_376,
        bytesPerSecond: 7_010_000,
      },
    });
    await settle();
    expect(document.body.textContent).toContain('正在校验并提交镜像归档…');
    expect(document.body.textContent).toContain('427.62 / 427.62 MB');
    expect(document.body.textContent).not.toContain('MB/s');
    expect(document.body.textContent).not.toContain(
      kind === 'import' ? '正在上传镜像归档…' : '正在下载镜像归档…',
    );
    expect(completed).not.toHaveBeenCalled();
    if (kind === 'import') {
      publish({ stage: 'loading', output: '' });
      await settle();
      expect(document.body.textContent).toContain('正在导入镜像…');
      expect(document.body.textContent).not.toContain('MB/s');
    }
    publish({ stage: 'finishing', output: '' });
    await settle();
    expect(document.body.textContent).toContain('正在清理暂存文件…');
    expect(document.body.textContent).not.toContain('MB/s');
    expect(completed).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(completed).toHaveBeenCalledOnce();
  },
);
