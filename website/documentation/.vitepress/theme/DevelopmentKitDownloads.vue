<script setup lang="ts">
import kits from '../../development-kits.json';
import manifest from '../../reference-manifest.json';
</script>

<template>
  <table>
    <thead>
      <tr>
        <th>SDK 版本</th>
        <th>开发包</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="kit in kits" :key="kit.sdkVersion">
        <td>
          SDK {{ kit.sdkVersion
          }}<template v-if="kit.sdkVersion === manifest.sdkVersion">（当前规范）</template>
        </td>
        <td>
          <a :href="`/downloads/serverdeck-plugin-development-kit-${kit.sdkVersion}.zip`" download
            >下载 ZIP</a
          >
        </td>
      </tr>
    </tbody>
  </table>
</template>
