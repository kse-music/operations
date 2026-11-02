import { terminalAction } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { navigateWorkspace } from './ui-navigation.mjs';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function monitorChecks({ page, artifacts, passed, hostId, command, contains }) {
  const python = String.raw`import json,os,time,subprocess,base64,re
def cpu(): return list(map(int,open('/proc/stat').readline().split()[1:9]))
def net(): return {a.strip():[int(b.split()[0]),int(b.split()[8])] for a,b in [l.rsplit(':',1) for l in open('/proc/net/dev').readlines()[2:]]}
a=cpu();n=net();u=float(open('/proc/uptime').read().split()[0]);time.sleep(2);b=cpu();m=net();v=float(open('/proc/uptime').read().split()[0]);d=[max(0,y-x) for x,y in zip(a,b)]
env=dict(os.environ,LC_ALL='C');free=subprocess.check_output(['free','-b'],env=env,text=True);mem=[l.split() for l in free.splitlines() if l.startswith('Mem:')][0]
df=subprocess.check_output(['df','-P','-k','-T','/'],env=env,text=True).splitlines()[-1].split()
top=subprocess.check_output(['top','-b','-n','2','-d','0.5','-w','100'],env=env,text=True)
lines=[l for l in top.splitlines() if 'Cpu(s)' in l];idle=re.search(r'([\d.]+)\s+id',lines[-1]);wait=re.search(r'([\d.]+)\s+wa',lines[-1])
r={'hostname':os.uname().nodename,'memoryTotal':int(mem[1]),'memoryAvailable':int(mem[-1]),'dfTotal':int(df[2])*1024,'dfUsed':int(df[3])*1024,'cpuProc':100*(sum(d)-d[3]-d[4])/sum(d),'cpuTop':100-float(idle.group(1))-float(wait.group(1)),'elapsed':v-u,'cpuBefore':a,'cpuAfter':b,'netBefore':n,'netAfter':m}
print('__SD_MON'+'ITOR_REF__'+base64.b64encode(json.dumps(r).encode()).decode()+'__SD_MON'+'ITOR_END__')`;
  const encoded = Buffer.from(python).toString('base64');
  await command(`python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`);
  await contains('__SD_MONITOR_END__');
  const text = (await page.locator('.terminal-pane:visible .xterm-rows').innerText()).replace(
    /\s/g,
    '',
  );
  const match = text.match(/__SD_MONITOR_REF__([A-Za-z0-9+/=]+)__SD_MONITOR_END__/);
  assert(match, 'real Linux reference command must return a complete response');
  const reference = JSON.parse(Buffer.from(match[1], 'base64').toString());
  await terminalAction(page, page.locator('.terminal-pane:visible'), '监控');
  const snapshot = () =>
    page.evaluate(async (hostId) => {
      try {
        return await window.__TAURI_INTERNALS__.invoke('monitor_snapshot', { hostId, after: null });
      } catch (error) {
        if (error.code === 'NOT_FOUND') return null;
        throw new Error(error.code + ': ' + error.message);
      }
    }, hostId);
  async function until(predicate, seconds = 30) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const value = await snapshot();
      if (predicate(value)) return value;
      await delay(150);
    }
    throw new Error('monitor state deadline');
  }
  const first = await until((s) => s?.sample);
  assert.equal(first.hostId, hostId);
  assert(
    first.sample.cpus.every((c) => c.usage === null),
    'first CPU sample must be pending',
  );
  let current = await until((s) => s?.history.length >= 2 && s.sample.cpus[0]?.usage !== null);
  const sample = current.sample;
  assert.equal(sample.system.hostname, reference.hostname);
  assert.equal(sample.memory.total, reference.memoryTotal);
  assert(
    Math.abs(sample.memory.available - reference.memoryAvailable) <
      Math.max(64 * 1024 * 1024, reference.memoryTotal * 0.02),
  );
  const root = sample.disks.find((d) => d.mount === '/');
  assert(root && !root.error, 'root filesystem statistics must be available');
  assert.equal(root.total, reference.dfTotal);
  assert(Math.abs(root.used - reference.dfUsed) < 64 * 1024 * 1024);
  await page
    .getByTestId('monitor-cpu')
    .filter({ hasText: /\d+\.\d+%/ })
    .waitFor();
  const usage = sample.cpus.find((c) => c.name === 'cpu').usage;
  assert(usage >= 0 && usage <= 100);
  assert(Math.abs(usage - reference.cpuProc) < 25);
  assert(Math.abs(usage - reference.cpuTop) < 25);
  for (const iface of sample.network) {
    assert(reference.netAfter[iface.name], `interface ${iface.name} must occur in /proc/net/dev`);
    assert(iface.received >= reference.netBefore[iface.name][0]);
    assert(iface.sent >= reference.netBefore[iface.name][1]);
  }
  await writeFile(
    path.join(artifacts, 'monitor-reference.json'),
    JSON.stringify({ reference, sample }, null, 2),
  );
  passed(
    'native Linux monitor cross-check against top, free, df, /proc/stat and /proc/net/dev; first sample pending',
  );
  const svg = page.locator('.trend-chart svg').first();
  await svg.evaluate((e) => (e.dataset.instance = 'retained'));
  const revision = current.revision;
  current = await until((s) => s.revision > revision && s.history.length >= 3);
  assert.equal(await svg.getAttribute('data-instance'), 'retained');
  assert.equal(await page.locator('.trend-chart').count(), 4);
  passed('native persistent CPU/memory/network trend nodes and bounded backend history');
  const config = await page.evaluate(
    async () => (await window.__TAURI_INTERNALS__.invoke('app_bootstrap')).config,
  );
  try {
    await page.evaluate(
      (config) =>
        window.__TAURI_INTERNALS__.invoke('config_save', {
          config: { ...config, monitorIntervalSecs: 5 },
        }),
      config,
    );
    await until((s) => s.intervalSecs === 5);
  } finally {
    await page.evaluate(
      (config) => window.__TAURI_INTERNALS__.invoke('config_save', { config }),
      config,
    );
  }
  passed('native persisted sampling interval applies to the existing backend sampler');

  const session = current.sessionId;
  await page.getByRole('button', { name: '重新连接 / 继续', exact: true }).click();
  current = await until((s) => s?.sample && s.state !== 'connecting');
  assert.equal(current.sessionId, session, 'reopening charts must reuse one host sampler');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '全局设置', exact: true })
    .click();
  const paused = await until((s) => s.state === 'paused');
  await delay(4000);
  current = await snapshot();
  assert.equal(current.history.length, paused.history.length);
  assert.equal(current.revision, paused.revision);
  passed('native host sampler reuse and page-switch pause without additional samples');
  await navigateWorkspace(page, '服务器监控');
  current = await until(
    (s) =>
      ['partial', 'running'].includes(s.state) &&
      s.sample.cpus.find((c) => c.name === 'cpu')?.usage != null,
  );
  assert.equal(current.sessionId, session);
  await page
    .getByTestId('monitor-state')
    .filter({ hasText: /采样正常|部分指标不可用/ })
    .waitFor();
  await page
    .getByTestId('monitor-cpu')
    .filter({ hasText: /\d+\.\d+%/ })
    .waitFor();
  await page.screenshot({ path: path.join(artifacts, 'monitor.png') });
  await page.getByRole('button', { name: '停止监控', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已停止，采样任务和租约已释放' }).waitFor();
  const code = await page.evaluate(async (hostId) => {
    try {
      await window.__TAURI_INTERNALS__.invoke('monitor_snapshot', { hostId, after: null });
      return 'unexpected';
    } catch (e) {
      return e.code;
    }
  }, hostId);
  assert.equal(code, 'NOT_FOUND');
  await navigateWorkspace(page, 'SSH 终端');
  await command("printf '\\n__SD_%s__\\n' MONITOR_STOP_SURVIVED");
  await contains('__SD_MONITOR_STOP_SURVIVED__');
  passed('native resume and stop release monitor lease while shared Linux shell remains usable');
}
