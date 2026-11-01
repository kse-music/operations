import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import ts from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default ts.config(
  { ignores: ['**/dist/**', '**/gen/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { parser: ts.parser },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  prettier,
);
