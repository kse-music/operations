<script setup lang="ts">
import { computed } from 'vue';
import { File, Folder, FileSymlink, Search, Square } from '@lucide/vue';
import Modal from './Modal.vue';
import { tr } from '../i18n/messages';
import {
  bytes,
  fileSearchActive,
  type FileSearchOptions,
  type FileSearchResult,
  type FileSearchState,
} from '../types/files';

const props = defineProps<{
  state: FileSearchState;
  locating: boolean;
  locateError: string | null;
}>();
const emit = defineEmits<{
  change: [patch: Partial<FileSearchOptions>];
  search: [];
  stop: [];
  close: [];
  locate: [result: FileSearchResult];
}>();
const active = computed(() => fileSearchActive(props.state));
const busy = computed(() => props.locating || props.state.status === 'cancelling');
const labels = computed(() => ({
  idle: tr('输入条件后开始搜索'),
  starting: tr('正在准备搜索…'),
  running: tr('搜索中'),
  cancelling: tr('正在停止搜索…'),
  completed: props.state.skippedDirectories ? tr('结果不完整') : tr('搜索完成'),
  cancelled: tr('已停止 · 结果不完整'),
  limited: tr('已达搜索上限 · 结果不完整'),
  failed: tr('搜索失败 · 结果不完整'),
}));
function textChange(key: 'query' | 'path', event: Event): void {
  emit('change', { [key]: (event.target as HTMLInputElement).value });
}
function checkChange(key: 'recursive' | 'includeHidden', event: Event): void {
  emit('change', { [key]: (event.target as HTMLInputElement).checked });
}
function segments(name: string): [string, string, string] {
  const query = props.state.query.trim();
  if (query.includes('*') || query.includes('?')) return ['', name, ''];
  const at = name.toLowerCase().indexOf(query.toLowerCase());
  return !query || at < 0
    ? [name, '', '']
    : [name.slice(0, at), name.slice(at, at + query.length), name.slice(at + query.length)];
}
function submit(): void {
  if (busy.value) return;
  if (active.value) emit('stop');
  else emit('search');
}
</script>

<template>
  <Modal
    :title="tr('搜索远程文件')"
    panel-class="file-search-dialog"
    :busy="busy"
    @close="emit('close')"
  >
    <form class="file-search-form" @submit.prevent="submit">
      <div class="file-search-fields">
        <label for="file-search-query">{{ tr('文件名') }}</label>
        <input
          id="file-search-query"
          :value="state.query"
          :disabled="active || locating"
          maxlength="256"
          required
          autofocus
          :placeholder="tr('输入关键词或通配符，如 *.sh')"
          @input="textChange('query', $event)"
        />
        <label for="file-search-path">{{ tr('搜索目录') }}</label>
        <input
          id="file-search-path"
          :value="state.path"
          :disabled="active || locating"
          maxlength="4096"
          required
          @input="textChange('path', $event)"
        />
      </div>
      <div class="file-search-options">
        <label class="checkbox-label"
          ><input
            type="checkbox"
            :checked="state.recursive"
            :disabled="active || locating"
            @change="checkChange('recursive', $event)"
          />{{ tr('包含子目录') }}</label
        >
        <label class="checkbox-label"
          ><input
            type="checkbox"
            :checked="state.includeHidden"
            :disabled="active || locating"
            @change="checkChange('includeHidden', $event)"
          />{{ tr('包含隐藏文件') }}</label
        >
      </div>
      <div class="file-search-actions">
        <span class="subtle">{{ tr('支持 *、? 通配符 · 不区分大小写') }}</span>
        <button class="button" :class="{ primary: !active }" type="submit" :disabled="busy">
          <component :is="active ? Square : Search" :size="15" aria-hidden="true" />{{
            active ? tr('停止') : tr('搜索')
          }}
        </button>
      </div>
    </form>
    <div class="file-search-status" role="status" aria-live="polite">
      <span v-if="state.status !== 'idle'">{{ tr('{0} 个结果', state.entries.length) }}</span>
      <span class="subtle">{{ labels[state.status] }}</span>
    </div>
    <p v-if="active" class="subtle file-search-scan">
      {{ tr('已扫描 {0} 个目录、{1} 个项目', state.scannedDirectories, state.scannedEntries)
      }}<span v-if="state.currentPath"> · {{ state.currentPath }}</span>
    </p>
    <p v-if="state.message" class="error-text" role="alert">{{ tr(state.message) }}</p>
    <p v-if="locateError" class="error-text" role="alert">{{ locateError }}</p>
    <details v-if="state.skippedDirectories" class="file-search-issues">
      <summary>{{ tr('{0} 个目录未能读取，结果不完整', state.skippedDirectories) }}</summary>
      <ul>
        <li v-for="issue in state.issues" :key="issue.path">
          <span>{{ issue.path }}</span
          >：{{ tr(issue.message) }}
        </li>
      </ul>
    </details>
    <div class="file-search-results" :aria-busy="active || locating">
      <table v-if="state.entries.length" :aria-label="tr('搜索结果')">
        <thead>
          <tr>
            <th>{{ tr('名称') }}</th>
            <th>{{ tr('所在目录') }}</th>
            <th>{{ tr('大小') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="result in state.entries"
            :key="result.entry.path"
            @dblclick="!busy && emit('locate', result)"
          >
            <td>
              <button
                class="file-search-result-name"
                type="button"
                :disabled="busy"
                :aria-label="tr('定位 {0}', result.entry.path)"
                @keydown.enter.prevent="emit('locate', result)"
              >
                <component
                  :is="
                    result.entry.kind === 'directory'
                      ? Folder
                      : result.entry.kind === 'symlink'
                        ? FileSymlink
                        : File
                  "
                  :data-kind="result.entry.kind"
                  :size="16"
                  aria-hidden="true"
                />
                <span
                  >{{ segments(result.entry.name)[0]
                  }}<mark v-if="segments(result.entry.name)[1]">{{
                    segments(result.entry.name)[1]
                  }}</mark
                  >{{ segments(result.entry.name)[2] }}</span
                >
              </button>
            </td>
            <td>{{ result.parent }}</td>
            <td>{{ bytes(result.entry.size) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="host-empty">
        {{
          active
            ? tr('正在查找匹配的文件…')
            : state.status === 'idle'
              ? tr('点击搜索后显示结果')
              : state.status === 'completed' && !state.skippedDirectories
                ? tr('没有匹配的文件')
                : tr('尚无搜索结果')
        }}
      </p>
    </div>
  </Modal>
</template>
