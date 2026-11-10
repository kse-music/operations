import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { usePluginVisibility } from '@serverdeck/plugin-sdk/visibility';
import { useAssistantApi } from './api';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { AiExecution, AiPrepare, AiProposal, AiTurn } from './types';
import { useAssistantHosts } from './assistant-hosts';

const bytes = (value: string) => new TextEncoder().encode(value).length;
function history(turns: AiTurn[], input: AiPrepare): NonNullable<AiPrepare['history']> {
  const result: NonNullable<AiPrepare['history']> = [];
  for (const turn of turns.filter((t) => t.state === 'complete' && t.answer).slice(-6)) {
    result.push(
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer!.text },
    );
  }
  // Bound the actual encoded request, not character counts. Drop complete pairs;
  // cutting a string here could split a sensitive value before backend redaction.
  while (result.length && bytes(JSON.stringify({ ...input, history: result })) > 48 * 1024) {
    result.splice(0, 2);
  }
  return result;
}
export function useAssistant(keepRunning: Readonly<Ref<boolean>> = ref(false)) {
  const aiApi = useAssistantApi();
  const visible = usePluginVisibility();
  const hostContext = useAssistantHosts();
  let controller: AbortController | null = null;
  const turns = ref<AiTurn[]>([]),
    busy = ref<'prepare' | 'send' | 'execute' | ''>('');
  const error = ref('');
  const outputs = ref<Record<string, AiExecution>>({}),
    attempted = ref<string[]>([]),
    expired = ref<string[]>([]);
  let version = 0,
    disposed = false,
    requestId = '';
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let pollOffset = 0;
  let cleanup: Promise<void> | null = null;
  const cancelling = ref<string[]>([]);
  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (disposed || !visible.value || !Object.values(outputs.value).some((value) => value.pending))
      return;
    pollTimer = setTimeout(() => {
      void pollTransfers();
    }, 1000);
  }
  async function pollTransfers() {
    if (disposed || !visible.value || busy.value || polling) {
      schedulePoll();
      return;
    }
    const pending = Object.entries(outputs.value).filter(([, value]) => value.pending);
    if (!pending.length) return;
    const [proposalId] = pending[pollOffset++ % pending.length]!;
    const turn = turns.value.find((turn) =>
      turn.answer?.proposals.some((p) => p.id === proposalId),
    );
    if (!turn?.requestId) return;
    const current = version;
    polling = true;
    try {
      const result = await aiApi.poll(turn.requestId);
      if (!disposed && current === version) {
        outputs.value[proposalId] = result;
        turn.task = result.task ?? turn.task;
      }
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      if (
        !disposed &&
        current === version &&
        !['BUSY', 'PLUGIN_BUSY', 'PLUGIN_RATE_LIMIT'].includes(code ?? '')
      )
        error.value = `传输状态读取失败：${errorMessage(cause)}`;
    } finally {
      polling = false;
      schedulePoll();
    }
  }
  async function cancelTransfer(proposalId: string) {
    const transfer = outputs.value[proposalId]?.transfer;
    if (!transfer || !outputs.value[proposalId]?.pending || cancelling.value.includes(proposalId))
      return;
    const current = version;
    cancelling.value.push(proposalId);
    try {
      const state = await aiApi.cancelTransfer(transfer.id);
      if (!disposed && current === version && outputs.value[proposalId])
        outputs.value[proposalId] = { ...outputs.value[proposalId]!, transfer: state };
    } catch (cause) {
      if (!disposed && current === version) error.value = errorMessage(cause);
    } finally {
      cancelling.value = cancelling.value.filter((id) => id !== proposalId);
      schedulePoll();
    }
  }
  watch([visible, outputs, busy], schedulePoll, { deep: true });
  async function refreshTask(turn: AiTurn, fallback: 'failed' | 'unverified') {
    if (!turn.task) return;
    const current = version;
    try {
      const snapshot = await aiApi.task(turn.task.id);
      if (!disposed && current === version) turn.task = snapshot;
    } catch (cause) {
      if (disposed || current !== version) return;
      turn.task = { ...turn.task, status: fallback };
      error.value = [error.value, `任务状态读取失败：${errorMessage(cause)}`]
        .filter(Boolean)
        .join('\n');
    }
  }
  async function revoke(id: string) {
    if (!id || (!visible.value && !keepRunning.value)) return;
    const current = version;
    try {
      await aiApi.cancel(id);
    } catch (e) {
      if (!disposed && current === version) error.value = errorMessage(e);
    }
  }
  function invalidate() {
    if (pollTimer) clearTimeout(pollTimer);
    for (const value of Object.values(outputs.value))
      if (value.pending && value.transfer) {
        void aiApi.cancelTransfer(value.transfer.id).catch((cause: unknown) => {
          if (!disposed) error.value = errorMessage(cause);
        });
      }
    controller?.abort();
    hostContext.clear();
    version++;
    const ids = new Set(turns.value.map((t) => t.requestId).filter(Boolean));
    if (requestId) ids.add(requestId);
    if (ids.size) {
      const draining = (cleanup ?? Promise.resolve()).then(async () => {
        for (const id of ids) await revoke(id);
      });
      cleanup = draining;
      void draining.then(() => {
        if (cleanup === draining) cleanup = null;
      });
    }
    requestId = '';
    turns.value = [];
    outputs.value = {};
    attempted.value = [];
    expired.value = [];
    error.value = '';
  }
  watch([visible, keepRunning], ([active, retained]) => {
    if (active) return;
    if (retained) return;
    controller?.abort();
    ++version;
    requestId = '';
    error.value = '';
    // The Host revokes these resources when the page hides. Keep readable history,
    // but never attempt to cancel or execute handles from the previous context.
    for (const output of Object.values(outputs.value))
      if (output.pending) {
        output.pending = false;
        output.success = false;
        output.output = '所属页面已释放，传输结果未确认，请独立核对目标文件';
      }
    for (const turn of turns.value) {
      turn.requestId = '';
      if (turn.state === 'pending') {
        turn.state = 'cancelled';
        if (turn.task) turn.task = { ...turn.task, status: 'cancelled' };
      }
      for (const proposal of turn.answer?.proposals ?? [])
        if (!expired.value.includes(proposal.id)) expired.value.push(proposal.id);
    }
  });
  async function send(input: AiPrepare, initialHostIds: string[] = []) {
    const submitted = version;
    if (cleanup) await cleanup;
    if (disposed || submitted !== version) return;
    if (busy.value) return;
    const current = version;
    const previousHostIds =
      [...turns.value].reverse().find((t) => t.hostIds.length)?.hostIds ?? initialHostIds;
    controller = new AbortController();
    const turn: AiTurn = {
      id: crypto.randomUUID(),
      approvalMode: input.approvalMode ?? 'request',
      question: input.question,
      state: 'pending',
      answer: null,
      error: '',
      requestId: '',
      hostIds: [],
      task: null,
    };
    turns.value.push(turn);
    const entry = turns.value[turns.value.length - 1]!;
    if (turns.value.length > 20) {
      const removed = turns.value.shift()!;
      void revoke(removed.requestId);
      for (const p of removed.answer?.proposals ?? []) {
        delete outputs.value[p.id];
        attempted.value = attempted.value.filter((id) => id !== p.id);
      }
    }
    error.value = '';
    busy.value = 'prepare';
    let retained = false;
    let automatic: AiProposal | undefined;
    try {
      if (keepRunning.value && aiApi.begin) {
        await aiApi.begin();
        retained = true;
        if (disposed || current !== version) return;
      }
      let targetInput = input;
      if (input.autoHosts) {
        requestId = crypto.randomUUID();
        const { route, sessionIds } = await hostContext.resolve(
          input,
          previousHostIds,
          requestId,
          controller.signal,
          (ids) => {
            entry.hostIds = ids;
          },
        );
        if (disposed || current !== version) return;
        if (route.message && !route.hostIds.length) {
          entry.answer = {
            text: route.message,
            proposals: [],
            usage: null,
            warnings: [],
          };
          entry.state = 'complete';
          return;
        }
        targetInput = {
          ...input,
          sessionId: null,
          sessionIds,
          expectedModelRevision: route.modelRevision,
        };
      }
      const previous = history(turns.value, targetInput);
      const historyOmitted =
        turns.value.filter((turn) => turn.state === 'complete' && turn.answer).length >
        previous.length / 2;
      const prepared = await aiApi.prepare({ ...targetInput, history: previous });
      if (disposed || current !== version) {
        await revoke(prepared.id);
        return;
      }
      requestId = prepared.id;
      entry.requestId = prepared.id;
      entry.task = prepared.task ? { ...prepared.task, status: 'running' } : null;
      busy.value = 'send';
      // Sending consumes the frozen native request; command execution is reviewed separately.
      const answer = await aiApi.send(prepared.id, true);
      if (!disposed && current === version) {
        entry.answer = {
          ...answer,
          warnings: [
            ...new Set([
              ...prepared.warnings,
              ...answer.warnings,
              ...(historyOmitted ? ['已按请求预算省略较早的完整历史轮次。'] : []),
            ]),
          ],
        };
        entry.state = 'complete';
        entry.task = answer.task ?? entry.task;
        if (entry.approvalMode === 'assist' && visible.value)
          automatic = answer.proposals.find((p) => p.risk !== 'manual_only');
      }
    } catch (e) {
      if (!disposed && current === version) {
        entry.error = errorMessage(e);
        entry.state = 'failed';
        await refreshTask(entry, 'failed');
      }
    } finally {
      if (retained) await end();
      busy.value = '';
      requestId = '';
      hostContext.phase.value = '';
      controller = null;
    }
    if (automatic && !disposed && current === version && visible.value)
      await executeProposal(automatic);
  }
  async function end() {
    try {
      await aiApi.end?.();
    } catch (cause) {
      if (!disposed) error.value = errorMessage(cause);
    }
  }
  async function cancel() {
    controller?.abort();
    const id = requestId;
    if (busy.value === 'execute') {
      await revoke(id);
      return;
    }
    version++;
    requestId = '';
    const turn = turns.value.find((t) => t.state === 'pending');
    if (turn) {
      turn.state = 'cancelled';
      if (turn.task) turn.task = { ...turn.task, status: 'cancelled' };
    }
    await revoke(id);
  }
  function inspect(proposal: AiProposal) {
    if (
      busy.value ||
      expired.value.includes(proposal.id) ||
      attempted.value.includes(proposal.id) ||
      proposal.risk === 'manual_only'
    )
      return;
    return executeProposal(proposal);
  }
  async function executeProposal(proposal: AiProposal) {
    const submitted = version;
    if (cleanup) await cleanup;
    if (disposed || submitted !== version) return;
    if (
      !proposal ||
      expired.value.includes(proposal.id) ||
      attempted.value.includes(proposal.id) ||
      busy.value ||
      proposal.risk === 'manual_only'
    )
      return;
    const current = version;
    const turn = turns.value.find((turn) =>
      turn.answer?.proposals.some((p) => p.id === proposal.id),
    );
    attempted.value.push(proposal.id);
    if (turn?.task) turn.task = { ...turn.task, status: 'executing' };
    busy.value = 'execute';
    requestId = turn?.requestId ?? '';
    error.value = '';
    let retained = false;
    try {
      if (keepRunning.value && aiApi.begin) {
        await aiApi.begin();
        retained = true;
        if (disposed || current !== version) return;
      }
      const result = await aiApi.execute(proposal.id, true, null);
      if (!disposed && current === version) {
        outputs.value[proposal.id] = result;
        if (turn) turn.task = result.task ?? turn.task;
      }
    } catch (e) {
      if (current === version) {
        error.value = errorMessage(e);
        if (turn) await refreshTask(turn, 'unverified');
      }
    } finally {
      if (retained) await end();
      busy.value = '';
      requestId = '';
    }
  }
  onBeforeUnmount(() => {
    if (pollTimer) clearTimeout(pollTimer);
    disposed = true;
    invalidate();
  });
  return {
    hostContext,
    turns,
    busy,
    error,
    outputs,
    attempted,
    expired,
    send,
    cancel,
    inspect,
    invalidate,
    cancelling,
    cancelTransfer,
  };
}
