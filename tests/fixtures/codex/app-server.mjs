import { createInterface } from 'node:readline';

const scenario = process.argv[2];
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  switch (request.method) {
    case 'initialize':
      reply({ id: request.id, result: {} });
      break;
    case 'account/read':
      reply({ id: request.id, result: { account: null, requiresOpenaiAuth: true } });
      break;
    case 'thread/start':
      if (
        request.params.ephemeral !== true ||
        request.params.sandbox !== 'read-only' ||
        request.params.approvalPolicy !== 'never'
      ) {
        reply({ id: request.id, error: { code: -32602 } });
        break;
      }
      reply({ id: request.id, result: { thread: { id: 'fixture-thread' } } });
      break;
    case 'mcpServerStatus/list':
      reply({
        id: request.id,
        result: {
          data: [{ runtimeStatus: scenario === 'mcp' ? 'connected' : 'disabled', tools: {} }],
          nextCursor: null,
        },
      });
      break;
    case 'turn/start':
      reply({ id: request.id, result: { turn: { id: 'fixture-turn' } } });
      if (scenario === 'hang') break;
      if (scenario === 'tool') {
        reply({ id: 42, method: 'item/commandExecution/requestApproval', params: {} });
        break;
      }
      if (scenario === 'oversize') {
        process.stdout.write('x'.repeat(1024 * 1024 + 1));
        break;
      }
      reply({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', text: '{"answer":"OK","commands":[]}' } },
      });
      if (scenario === 'crash') {
        process.exit(4);
      }
      reply({
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } } },
      });
      reply({
        method: 'turn/completed',
        params: {
          turn: { status: scenario === 'failed' ? 'failed' : 'completed', error: { code: 429 } },
        },
      });
      break;
  }
}
