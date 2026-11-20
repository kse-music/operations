import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WorkspaceArea } from '../stores/workspace';

const revealDelay = 180;
const hideDelay = 300;

export function useWorkspaceSidebar(area: () => WorkspaceArea) {
  const sidebar = ref<HTMLElement>();
  const edge = ref<HTMLButtonElement>();
  const pinned = ref({ home: true, local: true });
  const preview = ref(false);
  const collapsibleArea = computed(() => {
    const current = area();
    return current === 'home' || current === 'local' ? current : undefined;
  });
  const controls = computed(() =>
    collapsibleArea.value === 'local' ? 'local-session-panel' : 'host-tree-panel',
  );
  const autoHide = computed(() => {
    const current = collapsibleArea.value;
    return current !== undefined && !pinned.value[current];
  });
  const visible = computed(() => !autoHide.value || preview.value);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function ownsMenu(target: Element): boolean {
    return !!target.closest(`[data-sidebar-menu="${collapsibleArea.value}"]`);
  }

  function ownsTarget(target: EventTarget | null): boolean {
    return target instanceof Element && (!!sidebar.value?.contains(target) || ownsMenu(target));
  }

  function keepPreview(): boolean {
    if (sidebar.value?.matches(':hover')) return true;
    const focused = document.activeElement;
    return (
      !!focused &&
      (ownsMenu(focused) ||
        (!!sidebar.value?.contains(focused) &&
          focused.matches(':focus-visible, input, textarea, [contenteditable="true"]')))
    );
  }

  function dismissPreview(restoreFocus = false): void {
    clearTimer();
    if (!preview.value) return;
    const current = collapsibleArea.value;
    const restore = restoreFocus && ownsTarget(document.activeElement);
    preview.value = false;
    if (restore)
      void nextTick(() => {
        if (current === collapsibleArea.value && autoHide.value && !preview.value)
          edge.value?.focus({ preventScroll: true });
      });
  }

  function scheduleHide(): void {
    clearTimer();
    if (!preview.value) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!keepPreview()) dismissPreview(true);
    }, hideDelay);
  }

  function hoverEdge(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || event.buttons || timer !== undefined || !autoHide.value)
      return;
    timer = setTimeout(() => {
      preview.value = true;
      // The new overlay covers the edge. Check its hover state after layout even if the
      // pointer never crosses the overlay boundary while it is appearing.
      scheduleHide();
    }, revealDelay);
  }

  function leaveEdge(): void {
    if (!preview.value) clearTimer();
  }

  function enterSidebar(event: PointerEvent): void {
    if (event.pointerType === 'mouse') clearTimer();
  }

  function leaveSidebar(event: PointerEvent): void {
    if (event.pointerType === 'mouse') scheduleHide();
  }

  function focusPin(): void {
    sidebar.value
      ?.querySelector<HTMLButtonElement>(`.sidebar-toggle[aria-controls="${controls.value}"]`)
      ?.focus({ preventScroll: true });
  }

  async function openFromEdge(): Promise<void> {
    if (!autoHide.value) return;
    const current = collapsibleArea.value;
    clearTimer();
    preview.value = true;
    await nextTick();
    if (current === collapsibleArea.value && preview.value) focusPin();
  }

  async function togglePin(): Promise<void> {
    const current = collapsibleArea.value;
    if (!current) return;
    clearTimer();
    const pin = !pinned.value[current];
    pinned.value[current] = pin;
    preview.value = false;
    await nextTick();
    if (current !== collapsibleArea.value || pin !== pinned.value[current]) return;
    if (pin) focusPin();
    else edge.value?.focus({ preventScroll: true });
  }

  function outsidePointer(event: PointerEvent): void {
    if (preview.value && !ownsTarget(event.target)) dismissPreview();
  }

  function focusOut(event: FocusEvent): void {
    if (preview.value && ownsTarget(event.target)) scheduleHide();
  }

  function escape(event: KeyboardEvent): void {
    if (
      preview.value &&
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.isComposing &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      dismissPreview(true);
    }
  }

  watch(area, () => dismissPreview(), { flush: 'sync' });
  onMounted(() => {
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('keydown', escape);
  });
  onBeforeUnmount(() => {
    clearTimer();
    document.removeEventListener('pointerdown', outsidePointer, true);
    document.removeEventListener('focusout', focusOut);
    document.removeEventListener('keydown', escape);
  });

  return {
    sidebar,
    edge,
    controls,
    autoHide,
    preview,
    visible,
    hoverEdge,
    leaveEdge,
    enterSidebar,
    leaveSidebar,
    openFromEdge,
    togglePin,
  };
}
