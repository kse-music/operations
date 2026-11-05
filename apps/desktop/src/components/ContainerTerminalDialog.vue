<script setup lang="ts">
import { ref } from 'vue';
import type { Host } from '../types/hosts';
import { hostDisplayName } from '../types/hosts';
import type { ContainerShell } from '../types/ops';
import type { TerminalPaneModel } from '../stores/terminals';
import Modal from './Modal.vue';
import TerminalPane from './TerminalPane.vue';
const props = defineProps<{ host: Host; shell: ContainerShell }>();
const emit = defineEmits<{ close: [] }>();
const pane = ref<TerminalPaneModel>({
  key: crypto.randomUUID(),
  host: { ...props.host },
  containerShell: { ...props.shell },
  state: 'opening',
  connectRequested: true,
});
function update(value: Partial<Omit<TerminalPaneModel, 'key' | 'host'>>) {
  Object.assign(pane.value, value);
}
</script>
<template>
  <Modal
    :title="`${hostDisplayName(host)} · 容器 Shell · ${shell.id.slice(0, 12)}`"
    wide
    @close="emit('close')"
  >
    <div class="container-terminal-dialog">
      <TerminalPane
        :tab="pane"
        active
        standalone
        @update="update"
        @close="emit('close')"
        @action="
          (_key, action) => {
            if (action === 'close') emit('close');
          }
        "
      />
    </div>
  </Modal>
</template>
<style scoped>
.container-terminal-dialog {
  display: flex;
  flex-direction: column;
  height: min(620px, calc(100dvh - 160px));
  min-height: 180px;
  min-width: 0;
}
</style>
