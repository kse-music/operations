import { onBeforeUnmount, ref, shallowRef } from 'vue';
import { useAssistantApi } from '@serverdeck/plugin-sdk/services/plugin-tool-services';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import type { AiExecution, AiPrepare, AiProposal, AiTurn } from '@serverdeck/plugin-sdk/types/ai';
import { useAssistantHosts } from './assistant-hosts';

const bytes = (value: string) => new TextEncoder().encode(value).length;
function history(turns: AiTurn[]): NonNullable<AiPrepare['history']> {
  const result: NonNullable<AiPrepare['history']> = [];
  let size = 0;
  for (const turn of turns
    .filter((t) => t.state === 'complete' && t.answer)
    .slice(-6)
    .reverse()) {
    // Bound oversized old answers, without ever forwarding command/execution payloads.
    let content = turn.answer!.text;
    if (bytes(content) > 24 * 1024) {
      content = Array.from(content).slice(0, 6000).join('') + '\n[历史回答过长，后续内容已省略]';
    }
    const length = bytes(turn.question) + bytes(content);
    if (size + length > 48 * 1024) break;
    size += length;
    result.unshift({ role: 'user', content: turn.question }, { role: 'assistant', content });
  }
  return result;
}
export function useAssistant() {
  const aiApi = useAssistantApi();
  const hostContext = useAssistantHosts();
  let controller: AbortController | null = null;
  const turns = ref<AiTurn[]>([]),
    busy = ref<'prepare' | 'send' | 'execute' | ''>('');
  const error = ref(''),
    review = shallowRef<AiProposal | null>(null);
  const outputs = ref<Record<string, AiExecution>>({}),
    attempted = ref<string[]>([]);
  let version = 0,
    disposed = false,
    requestId = '';
  async function revoke(id: string) {
    if (!id) return;
    try {
      await aiApi.cancel(id);
    } catch (e) {
      if (!disposed) error.value = errorMessage(e);
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
    error.value = '';
  }
  async function send(input: AiPrepare) {
    if (busy.value) return;
    const current = version;
    const previous = history(turns.value);
    const previousHostIds = [...turns.value].reverse().find((t) => t.hostIds.length)?.hostIds ?? [];
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
    try {
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
            estimatedCost: null,
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
      const prepared = await aiApi.prepare({ ...targetInput, history: previous });
      if (disposed || current !== version) {
        await revoke(prepared.id);
        return;
      }
      requestId = prepared.id;
      entry.requestId = prepared.id;
      busy.value = 'send';
      // The host SDK reviews the frozen native request before sending it.
      const answer = await aiApi.send(prepared.id, true);
      if (!disposed && current === version) {
        entry.answer = answer;
        entry.state = 'complete';
      }
    } catch (e) {
      if (!disposed && current === version) {
        entry.error = errorMessage(e);
        entry.state = 'failed';
      }
    } finally {
      busy.value = '';
      requestId = '';
      hostContext.phase.value = '';
      controller = null;
    }
  }
  async function cancel() {
    controller?.abort();
    const id = requestId;
    version++;
    requestId = '';
    const turn = turns.value.find((t) => t.state === 'pending');
    if (turn) turn.state = 'cancelled';
    review.value = null;
    await revoke(id);
  }
  function inspect(proposal: AiProposal) {
    if (busy.value || attempted.value.includes(proposal.id) || proposal.risk === 'manual_only')
      return;
    review.value = proposal;
  }
  async function execute(confirmed: boolean, changeConfirmation: string) {
    const proposal = review.value;
    if (
      !proposal ||
      busy.value ||
      !confirmed ||
      (proposal.changeConfirmation !== null && proposal.changeConfirmation !== changeConfirmation)
    )
      return;
    const current = version;
    attempted.value.push(proposal.id);
    busy.value = 'execute';
    error.value = '';
    try {
      const result = await aiApi.execute(
        proposal.id,
        true,
        proposal.changeConfirmation === null ? null : changeConfirmation,
      );
      if (!disposed && current === version) outputs.value[proposal.id] = result;
    } catch (e) {
      if (current === version) error.value = errorMessage(e);
    } finally {
      if (current === version) review.value = null;
      busy.value = '';
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
    send,
    cancel,
    inspect,
    execute,
    invalidate,
  };
}
