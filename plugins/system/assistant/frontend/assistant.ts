import { tr } from './i18n/messages';
import { followProgress } from './progress';
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
  let stopCurrentProgress: (() => Promise<void>) | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let pollOffset = 0;
  let cleanup: Promise<void> | null = null;
  const cancelling = ref<string[]>([]);
  const resettingAccess = ref(false),
    accessResetError = ref('');
  let accessReset: Promise<void> | null = null;
  function revokeFullAccess(): Promise<void> {
    if (accessReset) return accessReset;
    for (const turn of turns.value) {
      if (turn.approvalMode !== 'full') continue;
      for (const proposal of turn.answer?.proposals ?? [])
        if (!expired.value.includes(proposal.id)) expired.value.push(proposal.id);
    }
    resettingAccess.value = true;
    accessResetError.value = '';
    const resetting = Promise.resolve()
      .then(() => aiApi.revokeFullAccess())
      .then(
        () => undefined,
        (cause: unknown) => {
          if (!disposed)
            accessResetError.value = tr('完全访问授权撤销失败，请重试：{0}', errorMessage(cause));
        },
      )
      .finally(() => {
        if (accessReset === resetting) {
          accessReset = null;
          resettingAccess.value = false;
        }
      });
    accessReset = resetting;
    return resetting;
  }
  const canContinue = (turn: AiTurn) =>
    visible.value || (keepRunning.value && !!turn.approvalMode && turn.approvalMode !== 'request');
  const automaticProposal = (turn: AiTurn) =>
    !turn.approvalMode || turn.approvalMode === 'request'
      ? undefined
      : turn.answer?.proposals.find(
          (p) =>
            p.risk !== 'manual_only' &&
            (visible.value ||
              (keepRunning.value && (p.risk === 'routine' || turn.approvalMode === 'full'))),
        );
  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (
      disposed ||
      (!visible.value && !keepRunning.value) ||
      !Object.values(outputs.value).some((value) => value.pending)
    )
      return;
    pollTimer = setTimeout(() => {
      void pollTransfers();
    }, 1000);
  }
  async function pollTransfers() {
    if (disposed || (!visible.value && !keepRunning.value) || busy.value || polling) {
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
    let continuation = false;
    try {
      const result = await aiApi.poll(turn.requestId);
      if (!disposed && current === version && outputs.value[proposalId]?.pending) {
        outputs.value[proposalId] = result;
        turn.task = result.task ?? turn.task;
        continuation = !!result.continuation;
      }
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      if (
        !disposed &&
        current === version &&
        outputs.value[proposalId]?.pending &&
        !cancelling.value.includes(proposalId) &&
        !['BUSY', 'PLUGIN_BUSY', 'PLUGIN_RATE_LIMIT'].includes(code ?? '')
      )
        error.value = tr('传输状态读取失败：{0}', errorMessage(cause));
    } finally {
      polling = false;
      schedulePoll();
    }
    if (continuation) await continueTask(turn, proposalId);
  }
  async function cancelTransfer(proposalId: string) {
    const output = outputs.value[proposalId];
    const transfer = output?.transfer;
    if (!output?.pending || (!transfer && !output.jobId) || cancelling.value.includes(proposalId))
      return;
    if (output.jobId && busy.value) return;
    const current = version;
    cancelling.value.push(proposalId);
    try {
      if (output.jobId) {
        const turn = turns.value.find((turn) =>
          turn.answer?.proposals.some((p) => p.id === proposalId),
        );
        if (!turn?.requestId) return;
        const cancelled = await aiApi.cancel(turn.requestId);
        const result = cancelled ?? (await aiApi.poll(turn.requestId));
        if (!disposed && current === version) {
          outputs.value[proposalId] = result;
          turn.task = result.task ?? turn.task;
        }
        return;
      }
      const state = await aiApi.cancelTransfer(transfer!.id);
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
      error.value = [error.value, tr('任务状态读取失败：{0}', errorMessage(cause))]
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
    void stopCurrentProgress?.();
    stopCurrentProgress = null;
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
    const interrupted = new Set(
      Object.entries(outputs.value)
        .filter(([, output]) => output.pending)
        .map(([id]) => id),
    );
    for (const output of Object.values(outputs.value))
      if (output.pending) {
        output.pending = false;
        output.success = false;
        output.output = output.jobId
          ? tr('所属页面已释放，任务结果未确认，请独立核对实际状态')
          : tr('所属页面已释放，传输结果未确认，请独立核对目标文件');
      }
    for (const turn of turns.value) {
      turn.requestId = '';
      if (turn.task && turn.answer?.proposals.some((p) => interrupted.has(p.id)))
        turn.task = { ...turn.task, status: 'unverified' };
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
    if (accessReset) await accessReset;
    if (disposed || submitted !== version || accessResetError.value) return;
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
    let progressId = '';
    let stopProgress: (() => Promise<void>) | undefined;
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
          { ...input, history: history(turns.value, input) },
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
      const progress = await aiApi.progressOpen();
      progressId = progress.id;
      if (disposed || current !== version) return;
      targetInput = { ...targetInput, progressId };
      const previous = history(turns.value, targetInput);
      const historyOmitted =
        turns.value.filter((turn) => turn.state === 'complete' && turn.answer).length >
        previous.length / 2;
      const prepared = await aiApi.prepare({ ...targetInput, history: previous, progressId });
      if (disposed || current !== version) {
        await revoke(prepared.id);
        return;
      }
      requestId = prepared.id;
      entry.requestId = prepared.id;
      entry.task = prepared.task ? { ...prepared.task, status: 'running' } : null;
      busy.value = 'send';
      // Sending consumes the frozen native request; command execution is reviewed separately.
      stopProgress = followProgress(
        (revision, offset) => aiApi.progressRead(progressId, revision, offset),
        () => visible.value,
        (text) => {
          if (!disposed && current === version) entry.streamText = text;
        },
        (cause) => {
          if (disposed || current !== version) return;
          entry.error = tr('流式显示读取失败：{0}', errorMessage(cause));
          void revoke(prepared.id);
        },
      );
      stopCurrentProgress = stopProgress;
      const answer = await aiApi.send(prepared.id, true);
      if (entry.error) throw new Error(entry.error);
      if (!disposed && current === version) {
        entry.answer = {
          ...answer,
          warnings: [
            ...new Set([
              ...prepared.warnings,
              ...answer.warnings,
              ...(historyOmitted ? [tr('已按请求预算省略较早的完整历史轮次。')] : []),
            ]),
          ],
        };
        entry.state = 'complete';
        entry.task = answer.task ?? entry.task;
        automatic = automaticProposal(entry);
      }
    } catch (e) {
      if (!disposed && current === version) {
        entry.error = errorMessage(e);
        entry.state = 'failed';
        await refreshTask(entry, 'failed');
      }
    } finally {
      await stopProgress?.();
      if (stopCurrentProgress === stopProgress) stopCurrentProgress = null;
      if (progressId) {
        try {
          await aiApi.progressClose(progressId);
        } catch (cause) {
          if (!disposed && current === version)
            error.value = tr('关闭回答进度失败：{0}', errorMessage(cause));
        }
      }
      if (retained) await end();
      busy.value = '';
      requestId = '';
      hostContext.phase.value = '';
      controller = null;
    }
    if (entry.answer?.continuation && !disposed && current === version && canContinue(entry))
      await continueTask(entry);
    else if (automatic && !disposed && current === version) await executeProposal(automatic);
  }
  async function end() {
    try {
      await aiApi.end?.();
    } catch (cause) {
      if (!disposed) error.value = errorMessage(cause);
    }
  }
  async function cancel() {
    void stopCurrentProgress?.();
    stopCurrentProgress = null;
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
    if (turn?.operations?.length) await refreshTask(turn, 'unverified');
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
    if (accessReset) await accessReset;
    if (disposed || submitted !== version || accessResetError.value) return;
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
    let continuation = false;
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
        continuation = !!result.continuation;
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
    if (continuation && turn) await continueTask(turn, proposal.id);
  }
  async function continueTask(turn: AiTurn, proposalId?: string) {
    if (
      disposed ||
      !canContinue(turn) ||
      busy.value ||
      !turn.requestId ||
      turn.task?.status !== 'running'
    )
      return;
    if (proposalId) {
      const execution = outputs.value[proposalId];
      if (!execution?.continuation) return;
      if (!(turn.operations ?? []).some((item) => item.proposalId === proposalId)) {
        (turn.operations ??= []).push({
          proposalId,
          report: { observations: [], steps: turn.answer?.agent?.steps ?? [] },
          execution,
        });
      }
      execution.continuation = false;
    }
    const current = version;
    const root = turn.requestId;
    let progressId = '';
    let stopProgress: (() => Promise<void>) | undefined;
    let automatic: AiProposal | undefined;
    let again = false;
    let retained = false;
    busy.value = 'send';
    requestId = root;
    turn.state = 'pending';
    turn.streamText = '';
    error.value = '';
    try {
      if (keepRunning.value && aiApi.begin) {
        await aiApi.begin();
        retained = true;
      }
      if (disposed || current !== version) return;
      progressId = (await aiApi.progressOpen()).id;
      if (disposed || current !== version) return;
      stopProgress = followProgress(
        (revision, offset) => aiApi.progressRead(progressId, revision, offset),
        () => visible.value,
        (text) => {
          if (!disposed && current === version) turn.streamText = text;
        },
        (cause) => {
          if (!disposed && current === version) {
            turn.error = errorMessage(cause);
            void revoke(root);
          }
        },
      );
      stopCurrentProgress = stopProgress;
      const answer = await aiApi.resume(root, progressId);
      if (turn.error) throw new Error(turn.error);
      if (!disposed && current === version) {
        turn.answer = {
          ...answer,
          warnings: [...new Set([...(turn.answer?.warnings ?? []), ...answer.warnings])],
        };
        turn.task = answer.task ?? turn.task;
        turn.state = 'complete';
        again = !!answer.continuation;
        automatic = automaticProposal(turn);
      }
    } catch (cause) {
      if (!disposed && current === version) {
        turn.error = errorMessage(cause);
        turn.state = 'failed';
        await stopProgress?.();
        await revoke(root);
        await refreshTask(turn, 'unverified');
      }
    } finally {
      await stopProgress?.();
      if (stopCurrentProgress === stopProgress) stopCurrentProgress = null;
      if (progressId) {
        try {
          await aiApi.progressClose(progressId);
        } catch (cause) {
          if (!disposed && current === version)
            error.value = tr('关闭回答进度失败：{0}', errorMessage(cause));
        }
      }
      if (retained) await end();
      busy.value = '';
      requestId = '';
    }
    if (disposed || current !== version || !canContinue(turn)) return;
    if (again) await continueTask(turn);
    else if (automatic) await executeProposal(automatic);
  }
  watch(visible, (active) => {
    if (!active || busy.value) return;
    const turn = turns.value.find(
      (turn) =>
        turn.task?.status === 'running' &&
        turn.requestId &&
        (turn.answer?.continuation ||
          (turn.answer?.proposals ?? []).some(
            (proposal) => outputs.value[proposal.id]?.continuation,
          )),
    );
    if (turn)
      void continueTask(
        turn,
        turn.answer?.proposals.find((proposal) => outputs.value[proposal.id]?.continuation)?.id,
      );
    else {
      const waiting = turns.value.find((turn) => {
        const proposal = automaticProposal(turn);
        return (
          turn.task?.status === 'awaiting_approval' &&
          proposal &&
          !attempted.value.includes(proposal.id) &&
          !expired.value.includes(proposal.id)
        );
      });
      const proposal = waiting && automaticProposal(waiting);
      if (
        proposal &&
        !attempted.value.includes(proposal.id) &&
        !expired.value.includes(proposal.id)
      )
        void executeProposal(proposal);
    }
  });
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
    resettingAccess,
    accessResetError,
    revokeFullAccess,
  };
}
