<script setup lang="ts">
import { ref } from 'vue';
import type { Host } from '../types/hosts';
import { hostDisplayName } from '../types/hosts';
import type { TerminalPaneModel } from '../stores/terminals';
import Modal from './Modal.vue';
import TerminalPane from './TerminalPane.vue';
const props = defineProps<{ host: Host; pluginId: string; owner: string; ticket: string }>();
const emit = defineEmits<{ close: [] }>();
const pane = ref<TerminalPaneModel>({
  key: crypto.randomUUID(),
  host: props.host,
  pluginTerminal: { pluginId: props.pluginId, owner: props.owner, ticket: props.ticket },
  state: 'opening',
  connectRequested: true,
});
</script>
<template>
  <Modal :title="`${hostDisplayName(host)} · 插件终端`" wide @close="emit('close')"
    ><div class="plugin-terminal">
      <TerminalPane
        :tab="pane"
        active
        standalone
        @update="(value) => Object.assign(pane, value)"
        @close="emit('close')"
        @action="
          (_key, action) => {
            if (action === 'close') emit('close');
          }
        "
      /></div
  ></Modal>
</template>
<style scoped>
.plugin-terminal {
  display: flex;
  flex-direction: column;
  height: min(620px, calc(100dvh - 160px));
  min-height: 180px;
  min-width: 0;
}
</style>
