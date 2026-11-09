import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
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
  const error = ref(''),
    review = shallowRef<AiProposal | null>(null);
  const outputs = ref<Record<string, AiExecution>>({}),
    attempted = ref<string[]>([]),
    expired = ref<string[]>([]);
  let version = 0,
    disposed = false,
    requestId = '';
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
    controller?.abort();
    hostContext.clear();
    version++;
    const ids = new Set(turns.value.map((t) => t.requestId).filter(Boolean));
    if (requestId) ids.add(requestId);
    for (const id of ids) void revoke(id);
    requestId = '';
    turns.value = [];
    review.value = null;
    outputs.value = {};
    attempted.value = [];
    expired.value = [];
    error.value = '';
  }
  watch([visible, keepRunning], ([active, retained]) => {
    if (active) return;
    review.value = null;
    if (retained) return;
    controller?.abort();
    ++version;
    requestId = '';
    review.value = null;
    error.value = '';
    // The Host revokes these resources when the page hides. Keep readable history,
    // but never attempt to cancel or execute handles from the previous context.
    for (const turn of turns.value) {
      turn.requestId = '';
      if (turn.state === 'pending') turn.state = 'cancelled';
      for (const proposal of turn.answer?.proposals ?? [])
        if (!expired.value.includes(proposal.id)) expired.value.push(proposal.id);
    }
  });
  async function send(input: AiPrepare, initialHostIds: string[] = []) {
    if (busy.value) return;
    const current = version;
    const previousHostIds =
      [...turns.value].reverse().find((t) => t.hostIds.length)?.hostIds ?? initialHostIds;
    controller = new AbortController();
    const turn: AiTurn = {
      id: crypto.randomUUID(),
      question: input.question,
      state: 'pending',
      answer: null,
      error: '',
      requestId: '',
      hostIds: [],
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
      }
    } catch (e) {
      if (!disposed && current === version) {
        entry.error = errorMessage(e);
        entry.state = 'failed';
      }
    } finally {
      if (retained) await end();
      busy.value = '';
      requestId = '';
      hostContext.phase.value = '';
      controller = null;
    }
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
    if (turn) turn.state = 'cancelled';
    review.value = null;
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
    review.value = proposal;
  }
  async function execute(confirmed: boolean, changeConfirmation: string) {
    const proposal = review.value;
    if (proposal) await executeProposal(proposal, confirmed, changeConfirmation);
  }
  async function executeProposal(
    proposal: AiProposal,
    confirmed: boolean,
    changeConfirmation: string,
  ) {
    if (
      !proposal ||
      expired.value.includes(proposal.id) ||
      busy.value ||
      !confirmed ||
      (proposal.changeConfirmation !== null && proposal.changeConfirmation !== changeConfirmation)
    )
      return;
    const current = version;
    attempted.value.push(proposal.id);
    busy.value = 'execute';
    requestId =
      turns.value.find((turn) => turn.answer?.proposals.some((p) => p.id === proposal.id))
        ?.requestId ?? '';
    error.value = '';
    let retained = false;
    try {
      if (keepRunning.value && aiApi.begin) {
        await aiApi.begin();
        retained = true;
        if (disposed || current !== version) return;
      }
      const result = await aiApi.execute(
        proposal.id,
        true,
        proposal.changeConfirmation === null ? null : changeConfirmation,
      );
      if (!disposed && current === version) outputs.value[proposal.id] = result;
    } catch (e) {
      if (current === version) error.value = errorMessage(e);
    } finally {
      if (retained) await end();
      if (current === version) review.value = null;
      busy.value = '';
      requestId = '';
    }
  }
  onBeforeUnmount(() => {
    disposed = true;
    invalidate();
  });
  return {
    hostContext,
    turns,
    busy,
    error,
    review,
    outputs,
    attempted,
    expired,
    send,
    cancel,
    inspect,
    execute,
    invalidate,
  };
}
