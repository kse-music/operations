// Protocol fixture only; production always starts the user's installed native CLI.
const scenario = process.argv[2];
for await (const _ of process.stdin) {
  /* wait for the host to close its input */
}
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (scenario === 'auth' || scenario === 'logged-out') {
  process.stderr.write('fixture-secret');
  emit({ loggedIn: scenario === 'auth', authMethod: 'oauth_token', apiProvider: 'firstParty' });
  process.exitCode = scenario === 'auth' ? 0 : 1;
} else if (scenario === 'hang') {
  setInterval(() => {}, 1000);
} else if (scenario === 'invalid') {
  process.stdout.write('invalid json\n');
} else if (scenario === 'oversize') {
  process.stdout.write('x'.repeat(1024 * 1024 + 1));
} else {
  if (scenario !== 'missing-init')
    emit({
      type: 'system',
      subtype: 'init',
      tools: scenario === 'tool' ? ['Bash'] : [],
      mcp_servers: scenario === 'mcp' ? [{ name: 'external' }] : [],
    });
  if (scenario === 'tool-use')
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
  if (scenario === 'stream') {
    emit({ type: 'stream_event', event: { type: 'message_start' } });
    emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"answer":"' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'OK","commands":[]}' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const result = {
    type: 'result',
    subtype: scenario === 'failed' ? 'error_max_turns' : 'success',
    is_error: scenario === 'failed',
    result: '{"answer":"OK","commands":[]}',
    permission_denials: scenario === 'denied' ? [{ tool_name: 'Bash' }] : [],
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
      output_tokens: 3,
    },
  };
  if (scenario !== 'partial') emit(result);
  if (scenario === 'duplicate') emit(result);
  if (scenario === 'crash') process.exitCode = 1;
}
