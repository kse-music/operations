import { tr } from '../i18n/messages';
import type { WorkspaceView } from './product';

export const settingsNavigation = [
  {
    view: 'settings',
    get label() {
      return tr('通用');
    },
    icon: 'general',
  },
  {
    view: 'settingsTerminal',
    get label() {
      return tr('终端');
    },
    icon: 'terminal',
  },
  {
    view: 'settingsShortcuts',
    get label() {
      return tr('快捷键');
    },
    icon: 'shortcuts',
  },
  {
    view: 'settingsStorage',
    get label() {
      return tr('数据与存储');
    },
    icon: 'storage',
  },
  {
    view: 'models',
    get label() {
      return tr('模型');
    },
    icon: 'models',
  },
  {
    view: 'plugins',
    get label() {
      return tr('插件');
    },
    icon: 'plugins',
  },
  {
    view: 'about',
    get label() {
      return tr('关于');
    },
    icon: 'about',
  },
] as const satisfies readonly { view: WorkspaceView; label: string; icon: string }[];
export type SettingsView = (typeof settingsNavigation)[number]['view'];
export function isSettingsView(view: WorkspaceView): view is SettingsView {
  return settingsNavigation.some((item) => item.view === view);
}
