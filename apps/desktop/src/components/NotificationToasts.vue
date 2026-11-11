<script setup lang="ts">
import { tr } from '../i18n/messages';

import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useNotificationsStore } from '../stores/notifications';

const notifications = useNotificationsStore();
const stack = ref<HTMLElement>();
const target = shallowRef<HTMLElement | string>('body');
let observer: MutationObserver;
let invalidForm: HTMLFormElement | null | undefined;

function notifyInvalid(event: Event): void {
  const field = event.target;
  if (
    !(field instanceof HTMLInputElement) &&
    !(field instanceof HTMLSelectElement) &&
    !(field instanceof HTMLTextAreaElement)
  )
    return;
  event.preventDefault();
  if (invalidForm !== undefined && invalidForm === field.form) return;
  invalidForm = field.form;
  queueMicrotask(() => (invalidForm = undefined));
  const label = field.getAttribute('aria-label') ?? field.labels?.[0]?.textContent?.trim();
  notifications.push(`${label ? `${label}：` : ''}${field.validationMessage}`, true);
  field.focus();
}

async function reveal(): Promise<void> {
  await nextTick();
  const element = stack.value;
  if (!element?.isConnected || !element.showPopover) return;
  // A popover inside the active dialog stays interactive above its native backdrop.
  element.hidePopover();
  if (notifications.items.length) element.showPopover();
}

watch([() => notifications.items, target], () => void reveal(), { flush: 'post' });
onMounted(() => {
  function locateDialog() {
    target.value =
      [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1) ?? 'body';
  }
  locateDialog();
  observer = new MutationObserver(locateDialog);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  document.addEventListener('invalid', notifyInvalid, true);
  void reveal();
});
onBeforeUnmount(() => {
  observer.disconnect();
  document.removeEventListener('invalid', notifyInvalid, true);
});
</script>

<template>
  <Teleport :to="target">
    <div ref="stack" class="toast-stack" popover="manual" :aria-label="tr('全局通知')">
      <div
        v-for="item in notifications.items"
        :key="item.id"
        :class="['toast', { error: item.error }]"
        :role="item.error ? 'alert' : 'status'"
      >
        <span>{{ item.text }}</span>
        <button
          class="text-button"
          :aria-label="tr('关闭通知')"
          @click="notifications.dismiss(item.id)"
        >
          ×
        </button>
      </div>
    </div>
  </Teleport>
</template>
