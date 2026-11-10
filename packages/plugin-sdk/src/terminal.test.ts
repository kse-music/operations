import { expect, it, vi } from 'vitest';
import { openTerminal } from './terminal';
import { request } from './transport';

vi.mock('./transport', () => ({ request: vi.fn(async () => undefined) }));

it('preserves the ticket-only terminal request', async () => {
  await openTerminal('one-use-ticket', 'host');
  expect(request).toHaveBeenLastCalledWith('terminal.open', {
    ticket: 'one-use-ticket',
    hostId: 'host',
  });
});

it('forwards optional display context without changing the ticket or host', async () => {
  await openTerminal('one-use-ticket', 'host', {
    title: 'backend-api',
    description: 'abcdef012345 · /bin/sh',
  });
  expect(request).toHaveBeenLastCalledWith('terminal.open', {
    ticket: 'one-use-ticket',
    hostId: 'host',
    presentation: { title: 'backend-api', description: 'abcdef012345 · /bin/sh' },
  });
});
