<script setup lang="ts">
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
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { hostDisplayName } from '@serverdeck/plugin-sdk/types/hosts';
import { useModelBinding } from './model-binding';
import AssistantTargets from './AssistantTargets.vue';
import AssistantMarkdown from './AssistantMarkdown';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import './assistant.css';
const props = defineProps<{ hostId?: string }>();
const suggestions = [
  {
    icon: Activity,
    title: '资源异常',
    description: '检查 CPU、内存与负载',
    question: '帮我排查当前主机 CPU 和内存使用异常的可能原因。',
  },
  {
    icon: Boxes,
    title: '容器排查',
    description: '分析容器状态与启动问题',
    question: '如何逐步排查 Docker 容器无法正常启动的问题？',
  },
  {
    icon: ListTree,
    title: '服务诊断',
    description: '梳理服务响应慢的原因',
    question: '帮我整理服务响应缓慢的排查步骤。',
  },
];
const ops = useOpsStore();
const hosts = useHostsStore();
const ai = useAssistant();
const binding = useModelBinding();
const { models, modelId, selected, loaded, loading, error: bindingError } = binding;
onMounted(() => {
  if (!hosts.catalog) void hosts.load();
});
const { turns, busy, error, review, outputs, attempted, expired } = ai;
const messages = ref<HTMLElement>(),
  chatForm = ref<HTMLFormElement>();
watch(
  [() => turns.value.map((t) => t.state).join(','), error],
  () => {
    if (messages.value) messages.value.scrollTop = messages.value.scrollHeight;
  },
  { flush: 'post' },
);
const question = ref('');
const trustRequired = computed(() =>
  ai.hostContext.matched.value.some((host) => ops.connections[host.id]?.trust),
);
const commandApproved = ref(false),
  changeConfirmation = ref('');
const ready = computed(
  () =>
    !busy.value &&
    loaded.value &&
    !loading.value &&
    !bindingError.value &&
    models.loaded &&
    !models.loading &&
    !models.error &&
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
watch(review, () => {
  commandApproved.value = false;
  changeConfirmation.value = '';
});
function send() {
  if (!ready.value) return;
  const text = question.value;
  question.value = '';
  void ai.send(
    {
      modelId: modelId.value,
      sessionId: null,
      autoHosts: true,
      question: text,
      selection: {
        server: true,
        metrics: true,
        processes: true,
        docker: true,
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
  if (loading.value || models.loading) return '正在读取模型配置…';
  if (bindingError.value || models.error) return '模型配置读取失败，请在插件设置中重试';
  if (modelId.value && !selected.value) return '绑定模型已删除，请在插件设置中重新绑定';
  if (!selected.value) return '请先在插件设置中绑定模型';
  if (!selected.value.hasKey) return '绑定模型未配置 Key，请在模型管理中补充';
  if (hosts.busy && !hosts.catalog) return '正在读取资产列表…';
  return 'Enter 发送 · Shift + Enter 换行';
});
</script>
<template>
  <section class="view ai-view" aria-label="AI 运维助手">
    <div class="ai-workspace">
      <section class="ai-chat" aria-label="对话">
        <div class="ai-chat-heading">
          <div>
            <MessageSquare :size="17" aria-hidden="true" />
            <h2>对话</h2>
            <span>当前会话</span>
          </div>
          <button
            class="text-button"
            type="button"
            :disabled="busy === 'execute'"
            @click="ai.invalidate"
          >
            <Plus :size="14" aria-hidden="true" />新对话
          </button>
        </div>
        <div
          ref="messages"
          class="ai-chat-messages"
          role="log"
          aria-label="对话消息"
          aria-live="polite"
        >
          <p v-if="bindingError || models.error" class="error-text" role="alert">
            {{ bindingError || models.error }}
          </p>
          <p v-if="hosts.error" class="error-text" role="alert">{{ hosts.error }}</p>
          <p v-if="ai.hostContext.cleanupError.value" class="error-text" role="alert">
            {{ ai.hostContext.cleanupError.value }}
          </p>
          <AssistantTargets
            v-if="trustRequired"
            :hosts="ai.hostContext.matched.value"
            :total="hosts.catalog?.hosts.length ?? 0"
            :busy="!!busy"
          />
          <div v-if="!turns.length" class="ai-chat-empty">
            <div class="ai-empty-icon"><Bot :size="28" aria-hidden="true" /></div>
            <h3>有什么需要一起排查？</h3>
            <p>直接提问，或让助手自动匹配相关服务器。</p>
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
              命中：{{
                turn.hostIds
                  .map((id) => {
                    const host = hosts.catalog?.hosts.find((h) => h.id === id);
                    return host ? hostDisplayName(host) : '已移除资产';
                  })
                  .join('、')
              }}
            </p>
            <div class="ai-chat-message assistant">
              <div class="ai-message-avatar"><Bot :size="18" aria-hidden="true" /></div>
              <div class="ai-message-content">
                <div v-if="turn.state === 'pending'" class="ai-chat-waiting" role="status">
                  <LoaderCircle :size="16" class="ai-spin" aria-hidden="true" />{{
                    busy === 'prepare'
                      ? ai.hostContext.phase.value || '正在读取主机上下文…'
                      : '正在思考…'
                  }}
                </div>
                <p v-else-if="turn.state === 'cancelled'" class="ai-chat-cancelled">已停止回答</p>
                <div v-else-if="turn.error" class="ai-chat-error" role="alert">
                  <p>{{ turn.error }}</p>
                  <button
                    class="text-button"
                    type="button"
                    :disabled="!!busy"
                    @click="question = turn.question"
                  >
                    重新编辑
                  </button>
                </div>
                <template v-else-if="turn.answer"
                  ><AssistantMarkdown :content="turn.answer.text" />
                  <div v-if="turn.answer.usage" class="ai-chat-usage">
                    {{ turn.answer.usage.inputTokens + turn.answer.usage.outputTokens }} Token
                  </div>
                  <details v-if="turn.answer.proposals.length" class="ai-chat-commands">
                    <summary>
                      <Terminal :size="14" aria-hidden="true" />命令建议
                      <span>{{ turn.answer.proposals.length }} 条 · 执行需审核</span>
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
                              ? '只读诊断'
                              : proposal.risk === 'change'
                                ? '系统变更 · 单独确认'
                                : '仅供人工审阅'
                          }}</span
                        ><span class="ai-proposal-target" :title="proposal.target ?? ''">{{
                          proposal.target ?? '无服务器目标'
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
                            expired.includes(proposal.id)
                          "
                          @click="ai.inspect(proposal)"
                        >
                          {{
                            expired.includes(proposal.id)
                              ? '上下文已切换，请重新提问'
                              : attempted.includes(proposal.id)
                                ? '已提交，不自动重试'
                                : '审核此命令'
                          }}
                        </button>
                      </div>
                      <div
                        v-if="outputs[proposal.id]"
                        role="status"
                        class="ai-execution"
                        :class="{ failed: !outputs[proposal.id]!.success }"
                      >
                        <p>
                          <CheckCircle2
                            v-if="outputs[proposal.id]!.success"
                            :size="14"
                            aria-hidden="true"
                          /><AlertTriangle v-else :size="14" aria-hidden="true" />{{
                            outputs[proposal.id]!.success
                              ? '执行成功'
                              : '命令失败，请核对服务器状态'
                          }}
                        </p>
                        <pre class="ai-output">{{ outputs[proposal.id]!.output }}</pre>
                      </div>
                    </article>
                  </details>
                  <details v-if="turn.answer.warnings.length > 1" class="ai-chat-notes">
                    <summary>响应提示</summary>
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
          aria-label="发送消息"
          @submit.prevent="send"
        >
          <label class="sr-only" for="assistant-question">问题</label
          ><textarea
            id="assistant-question"
            v-model="question"
            :disabled="!!busy"
            rows="2"
            maxlength="8192"
            required
            placeholder="输入问题，开始对话…"
            @keydown.enter="enter"
          />
          <div class="ai-chat-composer-footer">
            <span>{{ readinessHint }}</span
            ><button
              v-if="busy === 'prepare' || busy === 'send'"
              class="button"
              type="button"
              @click="ai.cancel"
            >
              <Square :size="12" aria-hidden="true" />停止</button
            ><button v-else class="button primary" type="submit" :disabled="!ready">
              <Send :size="14" aria-hidden="true" />发送
            </button>
          </div>
        </form>
      </section>
    </div>
    <Modal
      v-if="review"
      :title="review.risk === 'change' ? '单独确认系统变更' : '批准只读诊断'"
      :busy="busy === 'execute'"
      @close="review = null"
      ><div class="ai-command-review">
        <dl class="ai-destination">
          <div>
            <dt>固定目标</dt>
            <dd>{{ review.target }}</dd>
          </div>
        </dl>
        <pre class="ai-output ai-command">{{ review.command }}</pre>
        <p class="ai-proposal-reason">{{ review.reason }}</p>
        <label v-if="review.changeConfirmation" class="ai-change-confirm"
          >请手动输入：{{ review.changeConfirmation
          }}<input v-model="changeConfirmation" autocomplete="off" :disabled="!!busy" /></label
        ><label class="check ai-approval"
          ><input
            v-model="commandApproved"
            type="checkbox"
            :disabled="!!busy"
          />我已审核目标和这一条命令，批准执行</label
        >
        <p class="ai-caption">
          审批 10 分钟内有效，仅可使用一次。连接变化后拒绝执行；失败也不自动重试或提权。
        </p>
        <div class="dialog-actions">
          <button class="button" type="button" :disabled="!!busy" @click="review = null">
            取消</button
          ><button
            class="button primary"
            type="button"
            :disabled="
              !!busy ||
              !commandApproved ||
              (review.changeConfirmation !== null &&
                changeConfirmation !== review.changeConfirmation)
            "
            @click="ai.execute(commandApproved, changeConfirmation)"
          >
            {{ busy === 'execute' ? '执行中…' : '批准执行这一条' }}
          </button>
        </div>
      </div></Modal
    >
  </section>
</template>
