<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  Bot,
  ShieldCheck,
  Server,
  Activity,
  ListTree,
  Boxes,
  SlidersHorizontal,
  RefreshCw,
  Settings2,
  FileSearch,
  Send,
  LoaderCircle,
  Terminal,
  AlertTriangle,
  MessageSquare,
  CheckCircle2,
  LockKeyhole,
  Square,
  Plus,
  UserRound,
} from '@lucide/vue';
import { useAssistant } from './assistant';
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { useWorkspaceStore } from '@serverdeck/plugin-sdk/stores/workspace';
import { hostDisplayName } from '@serverdeck/plugin-sdk/types/hosts';
import type { AiSelection } from '@serverdeck/plugin-sdk/types/ai';
import type { LogSource } from '@serverdeck/plugin-sdk/types/ops';
import { useModelsStore } from '@serverdeck/plugin-sdk/stores/models';
import AssistantTargets from './AssistantTargets.vue';
import AssistantMarkdown from './AssistantMarkdown';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import './assistant.css';
const props = defineProps<{ hostId?: string }>();
const crossHosts = ref(false);
const contextOpen = ref(window.innerWidth >= 900);
const suggestions = [
  {
    icon: Activity,
    title: '资源异常',
    question: '帮我排查当前主机 CPU 和内存使用异常的可能原因。',
  },
  { icon: Boxes, title: '容器排查', question: '如何逐步排查 Docker 容器无法正常启动的问题？' },
  { icon: ListTree, title: '服务诊断', question: '帮我整理服务响应缓慢的排查步骤。' },
];
const ops = useOpsStore();
const hosts = useHostsStore(),
  workspace = useWorkspaceStore();
const ai = useAssistant(),
  models = useModelsStore();
onMounted(() => {
  void models.refresh();
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
const question = ref(''),
  maskAddresses = ref(true),
  redactValues = ref('');
const selection = ref({ server: false, metrics: false, processes: false, docker: false });
const logKind = ref('none'),
  logTarget = ref(''),
  logLines = ref(100),
  logScope = ref<'system' | 'user'>('system');
const commandApproved = ref(false),
  changeConfirmation = ref('');
const ready = computed(
  () =>
    !busy.value &&
    models.loaded &&
    !models.loading &&
    !models.error &&
    !!models.selected?.hasKey &&
    (!hosts.busy || hosts.catalog !== null) &&
    !!question.value.trim(),
);
watch(
  [
    crossHosts,
    () => props.hostId,
    maskAddresses,
    redactValues,
    () => JSON.stringify(selection.value),
    logKind,
    logTarget,
    logScope,
    logLines,
    () => models.selectedId,
    () => models.selected?.revision,
  ],
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
  let log: LogSource | null = null;
  if (logKind.value === 'file') log = { kind: 'file', path: logTarget.value };
  if (logKind.value === 'service')
    log = { kind: 'service', scope: logScope.value, unit: logTarget.value };
  if (logKind.value === 'container') log = { kind: 'container', id: logTarget.value };
  const context: AiSelection = { ...selection.value, log, logLines: logLines.value };
  const boundSession =
    props.hostId && !crossHosts.value ? ops.connections[props.hostId] : undefined;
  if (
    props.hostId &&
    !crossHosts.value &&
    (!boundSession?.session || boundSession.state !== 'connected')
  ) {
    error.value = '当前主机尚未连接，请先完成连接或指纹核验。';
    return;
  }
  const text = question.value;
  question.value = '';
  void ai.send({
    modelId: models.selectedId,
    sessionId: boundSession?.session?.id ?? null,
    autoHosts: !props.hostId || crossHosts.value,
    question: text,
    selection: context,
    maskAddresses: maskAddresses.value,
    redactValues: redactValues.value.split('\n').filter((v) => v.trim()),
  });
}
function enter(event: KeyboardEvent) {
  if (event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  if (ready.value) chatForm.value?.requestSubmit();
}
const contextCount = computed(
  () => Object.values(selection.value).filter(Boolean).length + (logKind.value !== 'none' ? 1 : 0),
);
const readinessHint = computed(() => {
  if (models.loading) return '正在读取模型列表…';
  if (!models.selected) return '请先选择已注册模型';
  if (!models.selected.hasKey) return '请在模型管理中补充 Key';
  if (hosts.busy && !hosts.catalog) return '正在读取资产列表…';
  return 'Enter 发送 · Shift + Enter 换行';
});
</script>
<template>
  <section class="view ai-view" aria-label="AI 运维助手">
    <header class="ai-page-heading">
      <div class="ai-page-title">
        <div class="ai-page-icon"><Bot :size="24" aria-hidden="true" /></div>
        <div>
          <h1>AI 运维助手</h1>
          <p>结合授权上下文，分析异常原因与排查方向。</p>
        </div>
      </div>
      <span class="ai-safety-badge"
        ><ShieldCheck :size="14" aria-hidden="true" />命令执行需审核</span
      >
    </header>

    <section class="ai-model-bar" aria-label="选择模型">
      <div class="ai-model-picker">
        <label for="assistant-model">使用模型</label
        ><select
          id="assistant-model"
          v-model="models.selectedId"
          aria-label="使用模型"
          :disabled="!!busy || models.loading"
        >
          <option value="">请选择已注册模型</option>
          <option v-for="model in models.models" :key="model.id" :value="model.id">
            {{ model.name }} · {{ model.config.model }}{{ model.hasKey ? '' : '（未设置 Key）' }}
          </option>
        </select>
      </div>
      <div v-if="models.selected" class="ai-model-summary">
        <span class="ai-model-key" :class="{ configured: models.selected.hasKey }"
          ><span aria-hidden="true"></span
          >{{ models.selected.hasKey ? 'Key 已配置' : '未设置 Key' }}</span
        ><span class="ai-model-endpoint" :title="models.selected.config.baseUrl">{{
          models.selected.config.baseUrl
        }}</span>
      </div>
      <div class="ai-model-actions">
        <button
          class="button ai-context-toggle"
          type="button"
          :aria-expanded="contextOpen"
          aria-controls="assistant-context"
          @click="contextOpen = !contextOpen"
        >
          <SlidersHorizontal :size="14" aria-hidden="true" />上下文<span v-if="contextCount">{{
            contextCount
          }}</span>
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="!!busy || models.loading"
          aria-label="刷新模型列表"
          title="刷新模型列表"
          @click="models.refresh"
        >
          <RefreshCw :size="15" :class="{ 'ai-spin': models.loading }" aria-hidden="true" /></button
        ><button
          class="button"
          type="button"
          :disabled="!!busy"
          @click="workspace.navigate('models')"
        >
          <Settings2 :size="14" aria-hidden="true" />管理模型
        </button>
      </div>
      <p v-if="models.loading" class="ai-model-message" role="status">正在读取模型列表…</p>
      <p v-if="models.error" class="ai-model-message error-text" role="alert">{{ models.error }}</p>
      <p v-else-if="models.loaded && !models.models.length" class="ai-model-message muted">
        尚未注册模型，请前往资产管理 → 模型管理。
      </p>
      <p
        v-else-if="models.selected && !models.selected.hasKey"
        class="ai-model-message warning-text"
      >
        所选模型未设置 Key，请在模型管理中编辑。
      </p>
    </section>

    <div class="ai-workspace" :class="{ 'without-context': !contextOpen }">
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
          <div v-if="!turns.length" class="ai-chat-empty">
            <div class="ai-empty-icon"><Bot :size="28" aria-hidden="true" /></div>
            <h3>有什么需要一起排查？</h3>
            <p>直接提问，或让助手自动匹配相关服务器。</p>
            <div class="ai-suggestions">
              <button
                v-for="suggestion in suggestions"
                :key="suggestion.title"
                type="button"
                @click="question = suggestion.question"
              >
                <component :is="suggestion.icon" :size="16" aria-hidden="true" /><span>{{
                  suggestion.title
                }}</span>
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
                      ? ai.hostContext.phase.value || '正在读取授权上下文…'
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
      <aside
        v-show="contextOpen"
        id="assistant-context"
        class="ai-card ai-context"
        aria-label="服务器上下文"
      >
        <div class="ai-panel-heading">
          <div>
            <Server :size="17" aria-hidden="true" />
            <h2>服务器上下文</h2>
          </div>
          <span class="ai-context-count">已选 {{ contextCount }} 项</span>
        </div>
        <fieldset :disabled="!!busy">
          <template v-if="hostId">
            <p>
              当前主机：{{
                hostDisplayName(hosts.catalog?.hosts.find((host) => host.id === hostId))
              }}
            </p>
            <label class="checkbox-label"
              ><input v-model="crossHosts" type="checkbox" />跨主机分析</label
            >
          </template>
          <AssistantTargets
            v-if="!hostId || crossHosts"
            :loading="hosts.busy"
            :hosts="ai.hostContext.matched.value"
            :total="hosts.catalog?.hosts.length ?? 0"
            :busy="!!busy"
          />
          <p v-if="hosts.error" class="error-text" role="alert">{{ hosts.error }}</p>
          <p v-if="ai.hostContext.cleanupError.value" class="error-text" role="alert">
            {{ ai.hostContext.cleanupError.value }}
          </p>
          <p v-if="!hosts.catalog?.hosts.length" class="ai-context-note">
            尚无服务器资产，可在主机管理中添加。
          </p>
          <div class="ai-context-section">
            <h3>授权读取范围</h3>
            <p class="ai-context-note">发送时仅读取已勾选内容。</p>
            <div class="ai-scope-list">
              <label class="ai-scope" :class="{ selected: selection.server }"
                ><Server :size="16" aria-hidden="true" /><span
                  ><strong>服务器信息</strong><small>系统信息与连接端点</small></span
                ><input v-model="selection.server" type="checkbox" aria-label="服务器信息"
              /></label>
              <label class="ai-scope" :class="{ selected: selection.metrics }"
                ><Activity :size="16" aria-hidden="true" /><span
                  ><strong>当前监控指标</strong><small>负载、内存、磁盘与网络</small></span
                ><input v-model="selection.metrics" type="checkbox" aria-label="当前监控指标"
              /></label>
              <label class="ai-scope" :class="{ selected: selection.processes }"
                ><ListTree :size="16" aria-hidden="true" /><span
                  ><strong>进程状态</strong><small>进程与资源使用情况</small></span
                ><input v-model="selection.processes" type="checkbox" aria-label="进程状态"
              /></label>
              <label class="ai-scope" :class="{ selected: selection.docker }"
                ><Boxes :size="16" aria-hidden="true" /><span
                  ><strong>Docker 容器状态</strong><small>容器列表与运行状态</small></span
                ><input v-model="selection.docker" type="checkbox" aria-label="Docker 容器状态"
              /></label>
            </div>
          </div>
          <div class="ai-context-section ai-log-settings">
            <label
              >选定日志<select v-model="logKind">
                <option value="none">不读取日志</option>
                <option value="file">指定日志文件</option>
                <option value="service">指定 systemd 服务</option>
                <option value="container">指定 Docker 容器</option>
              </select></label
            >
            <template v-if="logKind !== 'none'"
              ><label
                >{{
                  logKind === 'file'
                    ? '日志绝对路径'
                    : logKind === 'service'
                      ? '服务名（.service）'
                      : '完整容器 ID'
                }}<input v-model="logTarget" form="assistant-chat-form" required autocomplete="off"
              /></label>
              <div class="ai-log-options">
                <label v-if="logKind === 'service'"
                  >服务范围<select v-model="logScope">
                    <option value="system">系统</option>
                    <option value="user">当前用户</option>
                  </select></label
                ><label
                  >末尾行数<input
                    v-model.number="logLines"
                    form="assistant-chat-form"
                    type="number"
                    min="1"
                    max="200"
                    required
                /></label></div
            ></template>
          </div>
          <details class="ai-redaction">
            <summary><SlidersHorizontal :size="14" aria-hidden="true" />脱敏设置</summary>
            <div>
              <label class="check"
                ><input v-model="maskAddresses" type="checkbox" />脱敏 IP 地址和邮箱</label
              ><label
                >额外脱敏内容（每行一个，域名、用户名或业务标识等）<textarea
                  v-model="redactValues"
                  rows="3"
                  autocomplete="off"
                  placeholder="每行填写一项敏感内容"
                />
              </label>
              <p class="ai-context-note">
                自动脱敏覆盖常见凭据和私钥，仍需注意可能遗漏的敏感内容。
              </p>
            </div>
          </details>
          <p class="ai-context-footnote">
            <LockKeyhole :size="13" aria-hidden="true" /><span
              >监控指标需先启动监控。对话仅在当前会话保留，执行输出不回传。</span
            >
          </p>
        </fieldset>
      </aside>
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
