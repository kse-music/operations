<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ detail: Record<string, unknown> }>();
const services = computed(() => props.detail.services as Record<string, unknown>[]);
</script>
<template>
  <div class="docker-container-details">
    <p>项目：{{ detail.composeProject }} · {{ services.length }} 个已创建的服务容器</p>
    <p v-if="!services.length" class="host-empty">项目已无普通服务容器，请刷新项目列表。</p>
    <div v-else class="ops-table">
      <table>
        <thead>
          <tr>
            <th>服务</th>
            <th>容器</th>
            <th>镜像</th>
            <th>状态</th>
            <th>退出码</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="service in services" :key="String(service.ID)">
            <td>{{ service.Service }}</td>
            <td>{{ String(service.Name).replace(/^\//, '') }}</td>
            <td>{{ service.Image }}</td>
            <td>{{ service.State }}</td>
            <td>{{ service.ExitCode }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="subtle">
      显示当前已创建的容器，包含已停止的服务；不包含一次性运行容器和尚未创建的服务。
    </p>
  </div>
</template>
