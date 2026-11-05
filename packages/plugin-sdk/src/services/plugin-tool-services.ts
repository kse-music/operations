import { inject, type InjectionKey } from 'vue';
import { aiApi } from './ai';
import { tasksApi } from './tasks';
export type AssistantApi = Pick<
  typeof aiApi,
  'prepare' | 'resolveHosts' | 'send' | 'execute' | 'cancel'
>;
export const assistantApiKey: InjectionKey<AssistantApi> = Symbol('assistant-api');
export const tasksApiKey: InjectionKey<typeof tasksApi> = Symbol('tasks-api');
export const useAssistantApi = (): AssistantApi => inject(assistantApiKey, aiApi);
export const useTasksApi = () => inject(tasksApiKey, tasksApi);
