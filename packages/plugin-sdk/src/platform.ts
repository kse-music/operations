import { request } from './transport';
import type { PlatformRequest, Command } from './types/platform';
export function call<T>(operation: PlatformRequest): Promise<T> {
  return request<T>('platform.request', { operation });
}
export function command(program: string, ...args: string[]): Command {
  return { program, args, timeoutSecs: 30 };
}
export function script(value: string): Command {
  return command('sh', '-c', value);
}
