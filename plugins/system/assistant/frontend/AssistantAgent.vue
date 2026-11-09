<script setup lang="ts">
import type { AiAgentReport, AiExecution } from './types';
defineProps<{ report: AiAgentReport; execution?: AiExecution['agent'] }>();
const statuses = {
  verified: '已执行并复查',
  failed: '失败',
  unverified: '结果未确认',
  skipped: '未执行',
};
</script>
<template>
  <section class="ai-agent" aria-label="智能体查询与计划">
    <details v-if="report.observations.length" class="ai-chat-notes">
      <summary>已查询 {{ report.observations.length }} 项主机信息</summary>
      <ul>
        <li v-for="(item, index) in report.observations" :key="index">
          {{ item.query }}：{{ item.success ? `成功 · ${item.records} 条记录` : '查询失败' }}
          <span v-if="item.message"> · {{ item.message }}</span>
        </li>
      </ul>
    </details>
    <div v-if="report.steps.length" class="ai-agent-plan">
      <h4>执行计划 · {{ report.steps.length }} 项操作</h4>
      <p class="ai-caption">以下目标已经固定，确认后才会执行；执行前核对状态，完成后逐项复查。</p>
      <ol>
        <li v-for="(step, index) in report.steps" :key="index">
          <strong>{{ step.action }}</strong
          ><code>{{ step.target }}</code>
          <p v-if="execution?.steps[index]" role="status">
            {{ statuses[execution.steps[index]!.status] }} · {{ execution.steps[index]!.message }}
          </p>
        </li>
      </ol>
    </div>
  </section>
</template>
