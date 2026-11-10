<script setup lang="ts">
import type { AiAgentReport, AiExecution } from './types';
defineProps<{ report: AiAgentReport; execution?: AiExecution['agent'] }>();
const statuses = {
  succeeded: '查询成功',
  verified: '已执行并复查',
  failed: '失败',
  unverified: '结果未确认',
  skipped: '未执行',
  running: '正在执行',
};
</script>
<template>
  <section class="ai-agent" aria-label="智能体查询与计划">
    <details v-if="report.observations.length" class="ai-chat-notes">
      <summary>已查询 {{ report.observations.length }} 项主机信息</summary>
      <ul>
        <li v-for="(item, index) in report.observations" :key="index">
          {{ item.query }}：{{
            item.status === 'succeeded' ? `成功 · ${item.records} 条记录` : '查询失败'
          }}
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
          <template v-if="step.preview?.kind === 'edit'">
            <p>文件：{{ step.preview.path }} · 原文 SHA-256：{{ step.preview.baseSha256 }}</p>
            <pre class="ai-output" aria-label="文件修改差异">{{ step.preview.diff }}</pre>
          </template>
          <dl v-else-if="step.preview?.kind === 'transfer'" class="ai-destination">
            <div>
              <dt>源文件</dt>
              <dd>
                {{
                  step.preview.preview.source.kind === 'local'
                    ? '本机'
                    : step.preview.preview.source.hostId
                }}：{{ step.preview.preview.source.path }}
              </dd>
            </div>
            <div>
              <dt>目标文件</dt>
              <dd>
                {{ step.preview.preview.destination.hostId }}：{{
                  step.preview.preview.destination.path
                }}
              </dd>
            </div>
            <div>
              <dt>大小 / 覆盖</dt>
              <dd>
                {{ step.preview.preview.bytes }} 字节 ·
                {{ step.preview.preview.overwrite ? '允许覆盖' : '禁止覆盖'
                }}{{ step.preview.preview.targetExists ? '（目标已存在）' : '' }}
              </dd>
            </div>
          </dl>
          <p v-if="execution?.steps[index]" role="status">
            {{ statuses[execution.steps[index]!.status] }} · {{ execution.steps[index]!.message }}
          </p>
        </li>
      </ol>
    </div>
  </section>
</template>
