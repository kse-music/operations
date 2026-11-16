import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let closing = false;
function close(code) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const [binary, args] of [
  ['vite/bin/vite.js', ['--host', '127.0.0.1', '--port', '4180', '--strictPort']],
  [
    'vitepress/bin/vitepress.js',
    ['dev', 'documentation', '--host', '127.0.0.1', '--port', '4181', '--strictPort'],
  ],
]) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(`../node_modules/${binary}`, import.meta.url)), ...args],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  children.push(child);
  child.on('error', (error) => {
    console.error(error);
    close(1);
  });
  child.on('exit', (code) => {
    if (!closing) close(code ?? 1);
  });
}
process.on('SIGINT', () => close(0));
process.on('SIGTERM', () => close(0));
