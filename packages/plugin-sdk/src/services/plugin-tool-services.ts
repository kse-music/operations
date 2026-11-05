import { inject, type InjectionKey } from 'vue';
import { aiApi } from './ai';
export type AssistantApi = Pick<
  typeof aiApi,
  'prepare' | 'resolveHosts' | 'send' | 'execute' | 'cancel'
>;
export const assistantApiKey: InjectionKey<AssistantApi> = Symbol('assistant-api');
export const useAssistantApi = (): AssistantApi => inject(assistantApiKey, aiApi);
