<script setup lang="ts">
import DefaultTheme from 'vitepress/theme-without-fonts';
import { computed } from 'vue';
import { useData } from 'vitepress';
import manifest from '../../reference-manifest.json';
const { page, frontmatter } = useData();
const developer = computed(() => page.value.relativePath.startsWith('developers/'));
</script>

<template>
  <DefaultTheme.Layout>
    <template #doc-before>
      <div class="sd-doc-context">
        <span>{{ developer ? 'DEVELOPER CENTER' : 'PRODUCT DOCUMENTATION' }}</span
        ><span v-if="developer"
          >SDK {{ manifest.sdkVersion
          }}<template v-if="frontmatter.reference"> · 公开规范</template></span
        ><span v-else>本地优先 · 按步骤开始</span>
      </div>
    </template>
    <template #doc-footer-before>
      <div class="sd-doc-help">
        <span>需要进一步帮助？</span
        ><a
          href="https://github.com/kse-music/operations/issues"
          target="_blank"
          rel="noopener noreferrer"
          >反馈文档问题 ↗</a
        ><span>请勿附带凭据或未脱敏的业务数据。</span>
      </div>
    </template>
  </DefaultTheme.Layout>
</template>
