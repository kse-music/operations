<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowRight, LockKeyhole, Monitor, Play, Plus, Server, Square, Trash2 } from '@lucide/vue';
import { tr } from '../i18n/messages';
import { useForwardingStore } from '../stores/forwarding';
import Modal from '../components/Modal.vue';

const props = defineProps<{ hostId: string; inactive: boolean }>();
const store = useForwardingStore();
const workspace = store.forHost(props.hostId);
const formError = ref('');
const busy = computed(() => Boolean(workspace.pending));
const polling = computed(
  () => !props.inactive && !busy.value && workspace.rules.some((rule) => rule.id),
);
void store.loadRules(props.hostId);

watch(
  polling,
  (active, _, onCleanup) => {
    if (!active) return;
    const hostId = props.hostId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function poll() {
      await store.refresh(hostId);
      if (!stopped) timer = setTimeout(poll, 1000);
    }
    void poll();
    onCleanup(() => {
      stopped = true;
      clearTimeout(timer);
    });
  },
  { immediate: true },
);

function addRule(): void {
  formError.value = '';
  const { draft, rules } = workspace;
  const listenPort = Number(draft.listenPort);
  const targetHost = draft.targetHost.trim();
  const targetPort = Number(draft.targetPort);
  if (
    ![listenPort, targetPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)
  ) {
    formError.value = tr('端口必须为 1–65535。');
    return;
  }
  if (!targetHost) {
    formError.value = tr('请输入远端地址。');
    return;
  }
  if (rules.some((rule) => rule.input.listenPort === listenPort)) {
    formError.value = tr('此主机已有使用该本地端口的规则。');
    return;
  }
  void store.addRule(props.hostId, { listenPort, targetHost, targetPort });
}

function ruleLabel(state: string): string {
  switch (state) {
    case 'starting':
      return tr('正在启动');
    case 'running':
      return tr('正在监听');
    case 'stopping':
      return tr('正在停止');
    case 'failed':
      return tr('转发失败');
    default:
      return tr('已停止');
  }
}

function displayHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
</script>

<template>
  <section class="forwarding-view" :aria-label="tr('端口转发')">
    <header class="forwarding-heading">
      <h1>{{ tr('SSH 本地端口转发') }}</h1>
      <p class="subtle">
        {{ tr('通过本机端口访问 SSH 主机可连接的服务。') }}
      </p>
    </header>

    <form
      class="forwarding-form"
      autocomplete="off"
      @submit.prevent="addRule"
      @input="formError = ''"
    >
      <div class="forwarding-form-route">
        <div class="forwarding-side" role="group" aria-labelledby="forwarding-local-heading">
          <div id="forwarding-local-heading" class="forwarding-side-heading">
            <Monitor :size="16" aria-hidden="true" /> {{ tr('本机入口') }}
          </div>
          <div class="forwarding-field">
            <label for="forwarding-local-port">{{ tr('本地端口') }}</label>
            <div class="forwarding-local-address">
              <code>127.0.0.1</code>
              <input
                id="forwarding-local-port"
                v-model="workspace.draft.listenPort"
                inputmode="numeric"
                pattern="[0-9]{1,5}"
                placeholder="18080"
                required
              />
            </div>
          </div>
        </div>

        <div class="forwarding-bridge">
          <span><LockKeyhole :size="13" aria-hidden="true" />{{ tr('SSH 隧道') }}</span>
          <ArrowRight class="forwarding-bridge-arrow" :size="16" aria-hidden="true" />
        </div>

        <div class="forwarding-side" role="group" aria-labelledby="forwarding-target-heading">
          <div id="forwarding-target-heading" class="forwarding-side-heading">
            <Server :size="16" aria-hidden="true" /> {{ tr('远端目标') }}
          </div>
          <div class="forwarding-target-fields">
            <label class="forwarding-field">
              {{ tr('远端地址') }}
              <input
                v-model="workspace.draft.targetHost"
                spellcheck="false"
                maxlength="253"
                required
              />
            </label>
            <label class="forwarding-field">
              {{ tr('远端端口') }}
              <input
                v-model="workspace.draft.targetPort"
                inputmode="numeric"
                pattern="[0-9]{1,5}"
                placeholder="8080"
                required
              />
            </label>
          </div>
        </div>
      </div>
      <div class="forwarding-form-footer">
        <p v-if="formError" class="error-text" role="alert">{{ formError }}</p>
        <button class="button primary" type="submit" :disabled="busy || !workspace.rulesLoaded">
          <Plus :size="16" aria-hidden="true" />{{ tr('添加') }}
        </button>
      </div>
    </form>

    <section class="forwarding-rules-section" aria-labelledby="forwarding-rules-heading">
      <h2 id="forwarding-rules-heading">{{ tr('转发规则') }}</h2>
      <p v-if="workspace.statusError" class="error-text" role="status">
        {{ tr('无法刷新转发状态：{0}', workspace.statusError) }}
      </p>
      <div v-if="workspace.rulesError" class="forwarding-rules-feedback">
        <p class="error-text" role="alert">{{ workspace.rulesError }}</p>
        <button
          v-if="!workspace.rulesLoaded"
          type="button"
          class="button"
          @click="store.loadRules(hostId)"
        >
          {{ tr('重试') }}
        </button>
      </div>
      <p v-if="workspace.loadingRules" class="forwarding-empty subtle" role="status">
        {{ tr('正在读取转发规则…') }}
      </p>
      <p
        v-else-if="workspace.rulesLoaded && !workspace.rules.length"
        class="forwarding-empty subtle"
      >
        {{ tr('暂无转发规则。') }}
      </p>
      <ul v-else-if="workspace.rules.length" class="forwarding-rules">
        <li v-for="rule in workspace.rules" :key="rule.input.listenPort" class="forwarding-rule">
          <div class="forwarding-endpoints">
            <div>
              <span>{{ tr('本机入口') }}</span>
              <code>127.0.0.1:{{ rule.input.listenPort }}</code>
            </div>
            <ArrowRight :size="16" aria-hidden="true" />
            <div>
              <span>{{ tr('远端目标') }}</span>
              <code
                >{{ displayHost(rule.input.targetHost) }}<wbr /><span class="forwarding-port"
                  >:{{ rule.input.targetPort }}</span
                ></code
              >
            </div>
          </div>
          <div class="forwarding-status" role="status">
            <span class="forwarding-state" :data-state="rule.state">{{
              ruleLabel(rule.state)
            }}</span>
            <span v-if="rule.state === 'running'" class="subtle">
              {{ tr('{0} 个活动连接', rule.activeConnections) }}
            </span>
          </div>
          <div class="forwarding-actions">
            <button
              type="button"
              class="button"
              :disabled="busy"
              @click="rule.id ? store.stop(hostId, rule) : store.start(hostId, rule)"
            >
              <Square v-if="rule.id" :size="13" aria-hidden="true" />
              <Play v-else :size="13" aria-hidden="true" />
              {{ rule.id ? tr('停止') : tr('启动') }}
            </button>
            <button
              v-if="!rule.id"
              type="button"
              class="tool-button"
              :disabled="busy"
              :aria-label="tr('移除本地端口 {0} 的转发规则', rule.input.listenPort)"
              :title="tr('移除转发规则')"
              @click="store.removeRule(hostId, rule)"
            >
              <Trash2 :size="15" aria-hidden="true" />
            </button>
          </div>
          <p v-if="rule.message" class="forwarding-rule-error error-text" role="status">
            {{ rule.message }}
          </p>
        </li>
      </ul>
    </section>
  </section>
  <Modal
    v-if="!inactive && workspace.lease?.trust"
    :title="tr('确认 SSH 主机指纹')"
    :busy="!workspace.lease.id"
    @close="store.trust(hostId, false)"
  >
    <p>
      {{ displayHost(workspace.lease.trust.hostname) }}:{{ workspace.lease.trust.port }} ·
      {{ workspace.lease.trust.algorithm }}
    </p>
    <p>{{ tr('请从服务器控制台或其他可信渠道核对后再继续；不会在确认前发送认证信息。') }}</p>
    <code class="fingerprint">{{ workspace.lease.trust.fingerprint }}</code>
    <footer class="dialog-actions">
      <button
        class="button"
        type="button"
        :disabled="!workspace.lease.id"
        @click="store.trust(hostId, false)"
      >
        {{ tr('拒绝连接') }}
      </button>
      <button
        class="button primary"
        type="button"
        :disabled="!workspace.lease.id"
        @click="store.trust(hostId, true)"
      >
        {{ tr('已核对，信任并连接') }}
      </button>
    </footer>
  </Modal>
</template>

<style scoped>
.forwarding-view {
  display: grid;
  gap: 22px;
  max-width: 920px;
  margin-inline: auto;
}
.forwarding-heading h1 {
  font-size: var(--font-size-title);
}
.forwarding-heading p {
  margin: 4px 0 0;
}
.forwarding-form {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.forwarding-form-route {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.5fr);
  align-items: end;
  gap: 16px;
  padding: 16px;
}
.forwarding-side {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.forwarding-side-heading,
.forwarding-bridge span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.forwarding-side-heading {
  font-weight: 600;
}
.forwarding-side-heading svg,
.forwarding-bridge-arrow {
  color: var(--accent);
}
.forwarding-bridge {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding-bottom: 9px;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.forwarding-field {
  display: grid;
  gap: 5px;
  min-width: 0;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.forwarding-field input {
  width: 100%;
}
.forwarding-local-address,
.forwarding-target-fields {
  display: grid;
  gap: 8px;
}
.forwarding-local-address {
  grid-template-columns: auto minmax(0, 1fr);
}
.forwarding-local-address > code {
  display: grid;
  align-items: center;
  padding-inline: 8px;
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  background: var(--raised);
  font-size: var(--font-size-body);
}
.forwarding-target-fields {
  grid-template-columns: minmax(0, 1fr) minmax(6em, 0.4fr);
}
.forwarding-form-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}
.forwarding-form-footer .button {
  margin-inline-start: auto;
}
.forwarding-form-footer p,
.forwarding-rules-section > p {
  margin: 0;
}
.forwarding-rules-section {
  display: grid;
  gap: 9px;
}
.forwarding-rules-section h2 {
  margin: 0;
  font-size: var(--font-size-section);
}
.forwarding-rules,
.forwarding-empty {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.forwarding-empty {
  padding: 16px;
}
.forwarding-rules-feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.forwarding-rules-feedback p {
  margin: 0;
  overflow-wrap: anywhere;
}
.forwarding-rules {
  margin: 0;
  padding: 0;
  list-style: none;
}
.forwarding-rule {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 10em 9em;
  align-items: center;
  gap: 8px 16px;
  padding: 12px 16px;
}
.forwarding-rule + .forwarding-rule {
  border-top: 1px solid var(--border);
}
.forwarding-endpoints {
  display: grid;
  grid-template-columns: minmax(0, 17ch) auto minmax(0, 1fr);
  align-items: start;
  gap: 8px;
}
.forwarding-endpoints > div {
  display: grid;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.forwarding-endpoints svg {
  margin-top: calc(4px + var(--font-size-caption) * 1.5);
  color: var(--muted);
}
.forwarding-endpoints > div > span,
.forwarding-status {
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.forwarding-port {
  white-space: nowrap;
}
.forwarding-status {
  display: grid;
  justify-items: start;
  gap: 3px;
}
.forwarding-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--raised);
}
.forwarding-state::before {
  content: '';
  flex: 0 0 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.forwarding-state[data-state='running'] {
  color: var(--accent);
  background: var(--accent-bg);
}
.forwarding-state[data-state='failed'] {
  color: var(--error);
  background: var(--error-bg);
}
.forwarding-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.forwarding-actions .tool-button {
  width: var(--control-height);
  height: var(--control-height);
  flex-basis: var(--control-height);
}
.forwarding-rule-error {
  grid-column: 1 / -1;
  margin: 0;
  overflow-wrap: anywhere;
}
@container workspace (max-width: 680px) {
  .forwarding-form-route {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .forwarding-bridge {
    display: flex;
    align-items: center;
    padding: 0;
  }
  .forwarding-bridge-arrow {
    order: -1;
    transform: rotate(90deg);
  }
  .forwarding-rule {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .forwarding-endpoints {
    grid-column: 1 / -1;
  }
}
</style>
