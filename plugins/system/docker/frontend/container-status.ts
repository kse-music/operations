import { tr } from './i18n/messages';

const stateLabels = new Map([
  ['created', '已创建'],
  ['running', '运行中'],
  ['paused', '已暂停'],
  ['restarting', '重启中'],
  ['exited', '已退出'],
  ['removing', '删除中'],
  ['dead', '已失效'],
]);

export function containerStateText(state: unknown): string {
  if (typeof state !== 'string' || !state) return tr('未报告');
  return stateLabels.has(state) ? tr(stateLabels.get(state)!) : state;
}

export function containerExitText(state: unknown, code: unknown): string {
  if (state === 'created') return tr('尚未启动');
  if (state === 'running' || state === 'paused' || state === 'restarting') return tr('尚未退出');
  if (state !== 'exited' || typeof code !== 'number' || !Number.isInteger(code) || code < 0)
    return tr('退出结果未知');
  return code === 0 ? tr('正常结束') : tr('异常退出（退出码 {0}）', code);
}
