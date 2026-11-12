<script setup lang="ts">
import { tr } from './i18n/messages';

import { computed, onMounted, ref, watch } from 'vue';
import {
  Bot,
  ShieldCheck,
  Activity,
  ListTree,
  Boxes,
  FileSearch,
  Send,
  LoaderCircle,
  Terminal,
  AlertTriangle,
  MessageSquare,
  CheckCircle2,
  Square,
  Plus,
  UserRound,
} from '@lucide/vue';
import { useAssistant } from './assistant';
import { useHostCatalog } from './platform-state';
import { hostDisplayName } from './platform-state';
import { useModelBinding } from './model-binding';
import { isLocalModel, taskStatusLabels } from './types';
import AssistantMarkdown from './AssistantMarkdown';
import AssistantAgent from './AssistantAgent.vue';
import './assistant.css';
const props = defineProps<{ hostId?: string; keepRunning?: boolean }>();
const suggestions = [
  {
    icon: Activity,
    get title() {
      return tr('资源异常');
    },
    get description() {
      return tr('检查 CPU、内存与负载');
    },
    get question() {
      return tr('帮我排查当前主机 CPU 和内存使用异常的可能原因。');
    },
  },
  {
    icon: Boxes,
    get title() {
      return tr('容器排查');
    },
    get description() {
      return tr('查询状态、规划操作并复查');
    },
    get question() {
      return tr('查询当前主机 Docker 镜像，为删除 tag 为 <none> 的镜像生成计划，等我确认后执行。');
    },
  },
  {
    icon: ListTree,
    get title() {
      return tr('服务诊断');
    },
    get description() {
      return tr('梳理服务响应慢的原因');
    },
    get question() {
      return tr('帮我整理服务响应缓慢的排查步骤。');
    },
  },
];
const hosts = useHostCatalog();
const ai = useAssistant(computed(() => props.keepRunning ?? false));
const binding = useModelBinding();
const { models, modelId, selected, loaded, loading, error: bindingError, localSelected } = binding;
onMounted(() => {
  void hosts.load().catch(() => {
    // The catalog exposes the failure in its visible error state.
  });
});
const { turns, busy, error, outputs, attempted, expired } = ai;
const messages = ref<HTMLElement>(),
  chatForm = ref<HTMLFormElement>();
watch(
  [() => turns.value.map((t) => `${t.state}:${t.streamText?.length ?? 0}`).join(','), error],
  () => {
    if (messages.value) messages.value.scrollTop = messages.value.scrollHeight;
  },
  { flush: 'post' },
);
const question = ref('');
const approvalMode = ref<'request' | 'assist' | 'full'>('request');
const approvalModeDescriptions = {
  get request() {
    return tr('访问外部文件、网络或执行命令时请求批准；仅对新任务生效');
  },
  get assist() {
    return tr('安全校验通过的读取直接执行，仅对风险操作请求批准；仅对新任务生效');
  },
  get full() {
    return tr(
      '在已授予权限内自动执行，包括修改和删除；首次启用须宿主授权，持续生效直到切换模式或关闭会话',
    );
  },
};
watch(
  approvalMode,
  (mode, previous) => {
    if (previous === 'full' || ai.accessResetError.value) void ai.revokeFullAccess();
  },
  { flush: 'sync' },
);
function newConversation() {
  ai.invalidate();
  approvalMode.value = 'request';
  void ai.revokeFullAccess();
}
const ready = computed(
  () =>
    !busy.value &&
    !ai.resettingAccess.value &&
    !ai.accessResetError.value &&
    loaded.value &&
    !loading.value &&
    !bindingError.value &&
    (isLocalModel(modelId.value) || models.loaded) &&
    !models.loading &&
    (isLocalModel(modelId.value) || !models.error) &&
    !!selected.value?.hasKey &&
    (!hosts.busy || hosts.catalog !== null) &&
    !!question.value.trim(),
);
watch(
  [() => props.hostId, modelId, () => selected.value?.revision],
  () => {
    ai.invalidate();
  },
  { flush: 'sync' },
);
function send() {
  if (!ready.value) return;
  const text = question.value;
  question.value = '';
  void ai.send(
    {
      approvalMode: approvalMode.value,
      modelId: modelId.value,
      sessionId: null,
      entryHostId: props.hostId ?? null,
      autoHosts: true,
      question: text,
      selection: {
        server: true,
        metrics: false,
        processes: false,
        docker: false,
        log: null,
        logLines: 100,
      },
      maskAddresses: true,
      redactValues: [],
    },
    props.hostId ? [props.hostId] : [],
  );
}
function enter(event: KeyboardEvent) {
  if (event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  if (ready.value) chatForm.value?.requestSubmit();
}
const readinessHint = computed(() => {
  if (loading.value || models.loading) return tr('正在读取模型配置…');
  if (localSelected.value)
    return localSelected.value.status.model
      ? tr('{0} · Enter 发送 · Shift + Enter 换行', localSelected.value.name)
      : localSelected.value.status.message;
  if (bindingError.value || models.error) return tr('模型配置读取失败，请在插件设置中重试');
  if (modelId.value && !selected.value) return tr('绑定模型已删除，请在插件设置中重新绑定');
  if (!selected.value) return tr('请先在插件设置中绑定模型');
  if (!selected.value.hasKey) return tr('绑定模型未配置 Key，请在模型管理中补充');
  if (hosts.busy && !hosts.catalog) return tr('正在读取资产列表…');
  return tr('Enter 发送 · Shift + Enter 换行');
});
</script>
<template>
  <section class="view ai-view" :aria-label="tr('AI 运维助手')">
    <div class="ai-workspace">
      <section class="ai-chat" :aria-label="tr('对话')">
        <div class="ai-chat-heading">
          <div>
            <MessageSquare :size="17" aria-hidden="true" />
            <h2>{{ tr('对话') }}</h2>
            <span>{{ tr('当前会话') }}</span>
          </div>
          <button
            class="text-button"
            type="button"
            :disabled="busy === 'execute'"
            @click="newConversation"
          >
            <Plus :size="14" aria-hidden="true" />{{ tr('新对话 ') }}
          </button>
        </div>
        <div
          ref="messages"
          class="ai-chat-messages"
          role="log"
          :aria-label="tr('对话消息')"
          aria-live="polite"
        >
          <p v-if="localSelected && !localSelected.status.model" class="banner">
            {{ localSelected.status.message }}
            <button class="button" @click="binding.manageModels">
              {{ tr('打开平台模型设置') }}
            </button>
          </p>
          <p
            v-if="bindingError || (!isLocalModel(modelId) && models.error)"
            class="error-text"
            role="alert"
          >
            {{ bindingError || models.error }}
          </p>
          <p v-if="hosts.error" class="error-text" role="alert">{{ hosts.error }}</p>
          <p v-if="ai.hostContext.cleanupError.value" class="error-text" role="alert">
            {{ ai.hostContext.cleanupError.value }}
          </p>
          <p v-if="ai.accessResetError.value" class="error-text" role="alert">
            {{ ai.accessResetError.value }}
            <button class="button" @click="ai.revokeFullAccess">{{ tr('重试撤销授权') }}</button>
          </p>
          <div v-if="!turns.length" class="ai-chat-empty">
            <div class="ai-empty-icon"><Bot :size="28" aria-hidden="true" /></div>
            <h3>{{ tr('有什么需要一起排查？') }}</h3>
            <p>{{ tr('直接提问，或让助手自动匹配相关服务器。') }}</p>
            <div class="ai-suggestions">
              <button
                v-for="suggestion in suggestions"
                :key="suggestion.title"
                type="button"
                :aria-label="suggestion.title"
                @click="question = suggestion.question"
              >
                <component :is="suggestion.icon" :size="17" aria-hidden="true" /><span
                  class="ai-suggestion-text"
                  ><strong>{{ suggestion.title }}</strong
                  ><small>{{ suggestion.description }}</small></span
                >
              </button>
            </div>
          </div>
          <article v-for="turn in turns" :key="turn.id" class="ai-chat-turn">
            <div class="ai-chat-message user">
              <div class="ai-message-avatar"><UserRound :size="16" aria-hidden="true" /></div>
              <div class="ai-user-text">{{ turn.question }}</div>
            </div>
            <p v-if="turn.hostIds.length" class="ai-turn-targets">
              {{ tr(' 命中：')
              }}{{
                turn.hostIds
                  .map((id) => {
                    const host = hosts.catalog?.hosts.find((h) => h.id === id);
                    return host ? hostDisplayName(host) : tr('已移除资产');
                  })
                  .join('、')
              }}
            </p>
            <div class="ai-chat-message assistant">
              <div class="ai-message-avatar"><Bot :size="18" aria-hidden="true" /></div>
              <div class="ai-message-content">
                <p v-if="turn.task" class="ai-caption" role="status">
                  {{ tr(' 任务状态：') }}{{ taskStatusLabels[turn.task.status] }}
                </p>
                <div v-if="turn.state !== 'complete' && turn.streamText" class="ai-stream-preview">
                  <AssistantMarkdown :content="turn.streamText" />
                </div>
                <div v-if="turn.state === 'pending'" class="ai-chat-waiting" role="status">
                  <LoaderCircle :size="16" class="ai-spin" aria-hidden="true" />{{
                    busy === 'prepare'
                      ? ai.hostContext.phase.value || tr('正在读取主机上下文…')
                      : turn.streamText
                        ? tr('正在生成回答…')
                        : tr('正在思考…')
                  }}
                </div>
                <p v-else-if="turn.state === 'cancelled'" class="ai-chat-cancelled">
                  {{ tr('已停止回答') }}
                </p>
                <div v-else-if="turn.error" class="ai-chat-error" role="alert">
                  <p>{{ turn.error }}</p>
                  <button
                    class="text-button"
                    type="button"
                    :disabled="!!busy"
                    @click="question = turn.question"
                  >
                    {{ tr(' 重新编辑 ') }}
                  </button>
                </div>
                <details v-if="turn.operations?.length" class="ai-chat-notes">
                  <summary>{{ tr('工具执行记录') }} · {{ turn.operations.length }}</summary>
                  <div v-for="operation in turn.operations" :key="operation.proposalId">
                    <AssistantAgent
                      :report="operation.report"
                      :execution="operation.execution.agent"
                      completed
                    />
                    <pre class="ai-output">{{ operation.execution.output }}</pre>
                  </div>
                </details>
                <template v-if="turn.state === 'complete' && !turn.error && turn.answer"
                  ><AssistantMarkdown :content="turn.answer.text" />
                  <AssistantAgent
                    v-if="turn.answer.agent"
                    :report="turn.answer.agent"
                    :execution="outputs[turn.answer.proposals[0]?.id ?? '']?.agent"
                  />
                  <div v-if="turn.answer.usage" class="ai-chat-usage">
                    {{ turn.answer.usage.inputTokens + turn.answer.usage.outputTokens }} Token
                  </div>
                  <details
                    v-if="turn.answer.proposals.length"
                    class="ai-chat-commands"
                    :open="!!turn.answer.agent?.steps.length"
                  >
                    <summary>
                      <Terminal :size="14" aria-hidden="true" />{{
                        turn.answer.agent?.steps.length ? tr('计划审批') : tr('命令建议')
                      }}
                      <span>{{ turn.answer.proposals.length }}{{ tr(' 条 · 执行需审核') }}</span>
                    </summary>
                    <article
                      v-for="proposal in turn.answer.proposals"
                      :key="proposal.id"
                      class="ai-proposal"
                    >
                      <div class="ai-proposal-heading">
                        <span class="ai-risk" :class="proposal.risk"
                          ><ShieldCheck
                            v-if="proposal.risk === 'read_only'"
                            :size="13"
                            aria-hidden="true"
                          /><AlertTriangle
                            v-else-if="proposal.risk === 'change'"
                            :size="13"
                            aria-hidden="true"
                          /><FileSearch v-else :size="13" aria-hidden="true" />{{
                            proposal.risk === 'read_only'
                              ? tr('只读诊断')
                              : proposal.risk === 'change'
                                ? tr('系统变更 · 单独确认')
                                : tr('仅供人工审阅')
                          }}</span
                        ><span class="ai-proposal-target" :title="proposal.target ?? ''">{{
                          proposal.target ?? tr('无服务器目标')
                        }}</span>
                      </div>
                      <pre class="ai-command"><code>{{ proposal.command }}</code></pre>
                      <p class="ai-proposal-reason">{{ proposal.reason }}</p>
                      <div v-if="proposal.risk !== 'manual_only'" class="ai-proposal-actions">
                        <button
                          class="button"
                          type="button"
                          :disabled="
                            !!busy ||
                            attempted.includes(proposal.id) ||
                            expired.includes(proposal.id) ||
                            ai.resettingAccess.value ||
                            !!ai.accessResetError.value
                          "
                          @click="ai.inspect(proposal)"
                        >
                          {{
                            expired.includes(proposal.id)
                              ? tr('上下文已切换，请重新提问')
                              : attempted.includes(proposal.id)
                                ? tr('已提交，不自动重试')
                                : turn.answer.agent?.steps.length
                                  ? tr('执行计划')
                                  : tr('执行此操作')
                          }}
                        </button>
                      </div>
                      <div
                        v-if="outputs[proposal.id]"
                        role="status"
                        class="ai-execution"
                        :class="{
                          failed: !outputs[proposal.id]!.success && !outputs[proposal.id]!.pending,
                        }"
                      >
                        <p>
                          <LoaderCircle
                            v-if="outputs[proposal.id]!.pending"
                            :size="14"
                            aria-hidden="true"
                          />
                          <CheckCircle2
                            v-else-if="outputs[proposal.id]!.success"
                            :size="14"
                            aria-hidden="true"
                          /><AlertTriangle v-else :size="14" aria-hidden="true" />{{
                            outputs[proposal.id]!.pending
                              ? outputs[proposal.id]!.jobId
                                ? tr('工具任务运行中')
                                : tr('文件传输进行中')
                              : outputs[proposal.id]!.success
                                ? outputs[proposal.id]!.agent
                                  ? tr('计划已执行并完成复查')
                                  : tr('执行成功')
                                : tr('操作未确认成功，请核对实际状态')
                          }}
                        </p>
                        <pre class="ai-output">{{ outputs[proposal.id]!.output }}</pre>
                        <div v-if="outputs[proposal.id]!.transfer" :aria-label="tr('文件传输进度')">
                          <progress
                            :value="outputs[proposal.id]!.transfer!.transferredBytes"
                            :max="outputs[proposal.id]!.transfer!.totalBytes || 1"
                          />
                          <p>
                            {{ outputs[proposal.id]!.transfer!.transferredBytes }} /
                            {{ outputs[proposal.id]!.transfer!.totalBytes }}{{ tr(' 字节 · ')
                            }}{{ outputs[proposal.id]!.transfer!.bytesPerSecond
                            }}{{ tr(' 字节/秒 ') }}
                          </p>
                          <p v-if="outputs[proposal.id]!.transfer!.sha256">
                            SHA-256：{{ outputs[proposal.id]!.transfer!.sha256 }}
                          </p>
                          <p
                            v-for="path in outputs[proposal.id]!.transfer!.recoveryPaths"
                            :key="path"
                          >
                            {{ tr(' 需人工核对的恢复路径：') }}{{ path }}
                          </p>
                          <button
                            v-if="outputs[proposal.id]!.pending && !outputs[proposal.id]!.jobId"
                            class="button"
                            type="button"
                            :disabled="ai.cancelling.value.includes(proposal.id)"
                            @click="ai.cancelTransfer(proposal.id)"
                          >
                            {{ tr(' 取消传输 ') }}
                          </button>
                        </div>
                        <button
                          v-if="outputs[proposal.id]!.pending && outputs[proposal.id]!.jobId"
                          class="button"
                          type="button"
                          :disabled="!!busy || ai.cancelling.value.includes(proposal.id)"
                          @click="ai.cancelTransfer(proposal.id)"
                        >
                          {{ tr('停止任务') }}
                        </button>
                      </div>
                    </article>
                  </details>
                  <details v-if="turn.answer.warnings.length" class="ai-chat-notes">
                    <summary>{{ tr('上下文与响应提示') }}</summary>
                    <p v-for="warning in turn.answer.warnings" :key="warning">{{ warning }}</p>
                  </details>
                </template>
              </div>
            </div>
          </article>
          <p v-if="error" role="alert" class="ai-chat-error">{{ error }}</p>
        </div>
        <form
          id="assistant-chat-form"
          ref="chatForm"
          class="ai-chat-composer"
          :aria-label="tr('发送消息')"
          @submit.prevent="send"
        >
          <label class="sr-only" for="assistant-question">{{ tr('问题') }}</label
          ><textarea
            id="assistant-question"
            v-model="question"
            :disabled="!!busy"
            rows="2"
            maxlength="8192"
            required
            :placeholder="tr('输入问题，开始对话…')"
            @keydown.enter="enter"
          />
          <div class="ai-chat-composer-footer">
            <label class="ai-approval-mode" :class="{ 'ai-full-access': approvalMode === 'full' }">
              <ShieldCheck :size="14" aria-hidden="true" />
              <select
                v-model="approvalMode"
                :aria-label="tr('审批模式')"
                :disabled="!!busy"
                :title="approvalModeDescriptions[approvalMode]"
              >
                <option value="request">{{ tr('请求批准') }}</option>
                <option value="assist">{{ tr('帮我批准') }}</option>
                <option value="full">{{ tr('完全访问权限') }}</option>
              </select>
            </label>
            <span>{{ readinessHint }}</span
            ><button v-if="busy" class="button" type="button" @click="ai.cancel">
              <Square :size="12" aria-hidden="true" />{{ tr('停止') }}</button
            ><button v-else class="button primary" type="submit" :disabled="!ready">
              <Send :size="14" aria-hidden="true" />{{ tr('发送 ') }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </section>
</template>
