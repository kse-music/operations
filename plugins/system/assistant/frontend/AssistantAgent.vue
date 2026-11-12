<script setup lang="ts">
import { tr } from './i18n/messages';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';

import type { AiAgentReport, AiExecution } from './types';
defineProps<{ report: AiAgentReport; execution?: AiExecution['agent'] }>();
const statuses = {
  get succeeded() {
    return tr('查询成功');
  },
  get verified() {
    return tr('已执行并复查');
  },
  get failed() {
    return tr('失败');
  },
  get unverified() {
    return tr('结果未确认');
  },
  get skipped() {
    return tr('未执行');
  },
  get running() {
    return tr('正在执行');
  },
};
</script>
<template>
  <section class="ai-agent" :aria-label="tr('智能体查询与计划')">
    <details v-if="report.observations.length" class="ai-chat-notes">
      <summary>{{ tr('已查询 ') }}{{ report.observations.length }}{{ tr(' 项主机信息') }}</summary>
      <ul>
        <li v-for="(item, index) in report.observations" :key="index">
          {{ item.query }}：{{
            item.status === 'succeeded' ? tr('成功 · {0} 条记录', item.records) : tr('查询失败')
          }}
          <span v-if="item.message"> · {{ item.message }}</span>
        </li>
      </ul>
    </details>
    <div v-if="report.steps.length" class="ai-agent-plan">
      <h4>{{ tr('执行计划 · ') }}{{ report.steps.length }}{{ tr(' 项操作') }}</h4>
      <p class="ai-caption">
        {{ tr('以下目标已经固定，确认后才会执行；执行前核对状态，完成后逐项复查。') }}
      </p>
      <ol>
        <li v-for="(step, index) in report.steps" :key="index">
          <strong>{{ tr(step.action) }}</strong
          ><code>{{ step.target }}</code>
          <template v-if="step.preview?.kind === 'edit'">
            <p>
              {{ tr('文件：') }}{{ step.preview.path }}{{ tr(' · 原文 SHA-256：')
              }}{{ step.preview.baseSha256 }}
            </p>
            <pre class="ai-output" :aria-label="tr('文件修改差异')">{{ step.preview.diff }}</pre>
          </template>
          <dl v-else-if="step.preview?.kind === 'transfer'" class="ai-destination">
            <div>
              <dt>{{ tr('源文件') }}</dt>
              <dd>
                {{
                  step.preview.preview.source.kind === 'local'
                    ? tr('本机')
                    : step.preview.preview.source.hostId
                }}：{{
                  step.preview.preview.source.kind === 'local'
                    ? displayLocalPath(step.preview.preview.source.path)
                    : step.preview.preview.source.path
                }}
              </dd>
            </div>
            <div>
              <dt>{{ tr('目标文件') }}</dt>
              <dd>
                {{ step.preview.preview.destination.hostId }}：{{
                  step.preview.preview.destination.path
                }}
              </dd>
            </div>
            <div>
              <dt>{{ tr('大小 / 覆盖') }}</dt>
              <dd>
                {{ step.preview.preview.bytes }}{{ tr(' 字节 · ')
                }}{{ step.preview.preview.overwrite ? tr('允许覆盖') : tr('禁止覆盖')
                }}{{ step.preview.preview.targetExists ? tr('（目标已存在）') : '' }}
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
