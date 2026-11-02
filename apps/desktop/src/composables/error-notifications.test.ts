import { afterEach, beforeEach, expect, it } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { effectScope, ref } from 'vue';
import { useErrorNotifications } from './error-notifications';
import { useNotificationsStore } from '../stores/notifications';

let pinia: Pinia;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => disposePinia(pinia));

it('reports existing and new errors without repeating unchanged polling errors after dismissal', () => {
  const errors = ref<(string | null)[]>(['连接失败', null]);
  const scope = effectScope();
  scope.run(() => useErrorNotifications(errors));
  const notifications = useNotificationsStore();
  expect(notifications.items).toEqual([{ id: 1, text: '连接失败', error: true }]);
  notifications.dismiss(1);
  errors.value = ['连接失败', '读取失败'];
  expect(notifications.items.map((item) => item.text)).toEqual(['读取失败']);
  errors.value = ['连接失败', '读取失败'];
  expect(notifications.items).toHaveLength(1);
  scope.stop();
  errors.value = ['关闭后不应弹出'];
  expect(notifications.items).toHaveLength(1);
});

it('reports the same failure again after a retry clears it in the same tick', () => {
  const error = ref<string | null>(null);
  const scope = effectScope();
  scope.run(() => useErrorNotifications(error));
  const notifications = useNotificationsStore();
  error.value = '保存失败';
  notifications.dismiss(notifications.items[0]!.id);
  error.value = null;
  error.value = '保存失败';
  expect(notifications.items).toEqual([{ id: 2, text: '保存失败', error: true }]);
  scope.stop();
});
