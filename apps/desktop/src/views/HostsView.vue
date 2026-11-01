<script setup lang="ts">
import { useBackgroundStore } from '../stores/background';
const background = useBackgroundStore();
import { useOpsStore } from '../stores/ops';
import { computed, ref, watch } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { authLabels, type Host } from '../types/hosts';
import { useFilesStore } from '../stores/files';
const store = useHostsStore();
const files = useFilesStore();
const operations = useOpsStore();
const hostState = (id: string) =>
  background.connections
    ? background.hostState(id)
    : operations.hostState(id) !== '未连接'
      ? operations.hostState(id)
      : files.hostState(id);
defineEmits<{
  create: [];
  connect: [host: Host];
  files: [host: Host];
  monitor: [host: Host];
  operations: [host: Host];
  automation: [host: Host];
  edit: [host: Host];
  remove: [host: Host];
  copy: [host: Host];
  favorite: [host: Host];
  import: [];
  export: [];
  menu: [host: Host, event: MouseEvent];
}>();
const hostLimit = ref(100);
watch(
  () => [store.search, store.sort, store.tag, store.favorites],
  () => (hostLimit.value = 100),
);
const tags = computed(() => [...new Set(store.catalog?.hosts.flatMap((h) => h.tags) ?? [])].sort());
const credential = computed(() =>
  store.catalog?.credentials.find((c) => c.id === store.selected?.credentialId),
);
</script>
<template>
  <section class="hosts-view">
    <div class="section-heading">
      <div>
        <p class="eyebrow">HOST INVENTORY</p>
        <h1>主机管理</h1>
      </div>
      <div class="toolbar">
        <button class="button" :disabled="!store.catalog || store.busy" @click="$emit('import')">
          导入 OpenSSH</button
        ><button class="button" :disabled="!store.catalog || store.busy" @click="$emit('export')">
          导出配置</button
        ><button
          class="button primary"
          :disabled="!store.catalog || store.busy"
          @click="$emit('create')"
        >
          ＋ 新建主机
        </button>
      </div>
    </div>
    <p class="section-description">
      主机配置保存在本机。连接前校验 SSH 主机密钥，首次连接需确认指纹。
    </p>
    <div class="list-controls">
      <input
        v-model="store.search"
        aria-label="搜索列表"
        placeholder="搜索名称、地址、用户名、备注或标签"
      /><select v-model="store.tag" aria-label="按标签筛选">
        <option value="">全部标签</option>
        <option v-for="tag in tags" :key="tag">{{ tag }}</option></select
      ><select v-model="store.sort" aria-label="主机排序">
        <option value="name">名称排序</option>
        <option value="hostname">地址排序</option>
        <option value="updated">最近修改</option>
      </select>
    </div>
    <p v-if="store.busy && !store.catalog" role="status">正在读取 SQLite 主机配置…</p>
    <div v-else-if="store.catalog && !store.visible.length" class="workspace-empty">
      <h2>{{ store.catalog.hosts.length ? '没有匹配结果' : '还没有主机' }}</h2>
      <p>新建主机，或从 OpenSSH Config 预览导入。</p>
    </div>
    <div v-else-if="store.catalog" class="host-table-wrap">
      <table class="host-table">
        <thead>
          <tr>
            <th>主机</th>
            <th>地址</th>
            <th>认证 / 分组</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="host in store.visible.slice(0, hostLimit)"
            :key="host.id"
            :class="{ selected: host.id === store.selectedId }"
            @contextmenu.prevent="$emit('menu', host, $event)"
          >
            <td>
              <button class="text-button host-link" @click="store.selectedId = host.id">
                {{ host.favorite ? '★ ' : '' }}{{ host.name }}
              </button>
              <div class="tag-list">
                <span v-for="tag in host.tags" :key="tag">{{ tag }}</span>
              </div>
            </td>
            <td>
              <code>{{ host.username }}@{{ host.hostname }}:{{ host.port }}</code
              ><small class="subtle block">{{ hostState(host.id) }}</small>
            </td>
            <td>
              {{ authLabels[host.authType]
              }}<small class="subtle block">{{
                store.catalog.groups.find((g) => g.id === host.groupId)?.name ?? '未分组'
              }}</small>
            </td>
            <td>
              <div class="row-actions">
                <button class="text-button" :disabled="store.busy" @click="$emit('edit', host)">
                  编辑</button
                ><button
                  class="text-button"
                  :disabled="store.busy"
                  @click="$emit('menu', host, $event)"
                >
                  更多
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <button v-if="store.visible.length > hostLimit" class="button" @click="hostLimit += 100">
      显示更多主机（{{ hostLimit }} / {{ store.visible.length }}）
    </button>
    <article v-if="store.selected" class="host-detail">
      <div class="section-heading">
        <h2>{{ store.selected.name }}</h2>
        <div class="toolbar">
          <button
            class="text-button"
            :disabled="store.busy"
            @click="$emit('favorite', store.selected)"
          >
            {{ store.selected.favorite ? '取消收藏' : '收藏' }}</button
          ><button
            class="text-button"
            :disabled="store.busy"
            @click="$emit('copy', store.selected)"
          >
            复制配置</button
          ><button
            class="text-button"
            :disabled="store.busy"
            @click="$emit('edit', store.selected)"
          >
            编辑主机</button
          ><button
            class="text-button danger"
            :disabled="store.busy"
            @click="$emit('remove', store.selected)"
          >
            删除
          </button>
        </div>
      </div>
      <dl class="detail-grid">
        <div>
          <dt>连接地址</dt>
          <dd>{{ store.selected.hostname }}:{{ store.selected.port }}</dd>
        </div>
        <div>
          <dt>用户名</dt>
          <dd>{{ store.selected.username }}</dd>
        </div>
        <div>
          <dt>认证方式</dt>
          <dd>{{ authLabels[store.selected.authType] }}</dd>
        </div>
        <div>
          <dt>凭据</dt>
          <dd>
            {{
              store.selected.authType === 'agent'
                ? '系统 SSH Agent'
                : (credential?.name ?? '尚未关联，连接前需配置')
            }}
          </dd>
        </div>
        <div>
          <dt>连接超时</dt>
          <dd>{{ store.selected.connectTimeoutSecs }} 秒</dd>
        </div>
        <div>
          <dt>最近修改</dt>
          <dd>{{ store.selected.updatedAt }}</dd>
        </div>
      </dl>
      <p v-if="credential?.keyPath" class="path">私钥路径：{{ credential.keyPath }}</p>
      <p class="host-description">{{ store.selected.description || '暂无备注' }}</p>
      <button class="button" @click="$emit('automation', store.selected)">运维自动化</button>
      <button class="button" @click="$emit('operations', store.selected)">Linux 运维</button>
      <button class="button" @click="$emit('monitor', store.selected)">服务器监控</button>
      <button class="button" @click="$emit('files', store.selected)">打开 SFTP 文件</button>
      <button class="button primary" @click="$emit('connect', store.selected)">
        连接 / 新建终端
      </button>
    </article>
  </section>
</template>
