import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const repository = fileURLToPath(new URL('../', import.meta.url));
const unwrap = result => { assert.ok(result.ok, result.error); return result.value; };

if (process.argv[2] === '--fff-worker') {
  const { FileFinder } = await import('@ff-labs/fff-node');
  const finder = unwrap(FileFinder.create({ basePath: process.argv[3], followSymlinks: false }));
  assert.equal(unwrap(await finder.waitForScan(15000)), true);
  const deadline = Date.now() + 15000;
  while (!unwrap(finder.getScanProgress()).isWarmupComplete) {
    assert.ok(Date.now() < deadline, 'fff content warmup timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const listing = unwrap(finder.glob('**/*', { pageSize: Math.max(1, unwrap(finder.getScanProgress()).scannedFilesCount) }));
  assert.equal(listing.items.length, listing.totalMatched, 'Incomplete fff file enumeration');
  const files = listing.items.map(item => item.relativePath.replaceAll('\\', '/'));
  process.send({ ready: true, files, rssMiB: process.memoryUsage().rss / 1024 ** 2 });
  process.on('message', ({ pattern }) => {
    const result = unwrap(finder.grep(pattern, { mode: 'regex', smartCase: false, maxMatchesPerFile: 50, pageSize: 50 }));
    assert.equal(result.regexFallbackError, undefined);
    assert.equal(result.nextCursor, null, 'Benchmark query must fit one page for equivalent results');
    process.send({ rows: result.items.map(item => `${item.relativePath.replaceAll('\\', '/')}:${item.lineNumber}:${item.lineContent}`).sort(), rssMiB: process.memoryUsage().rss / 1024 ** 2 });
  });
  process.on('disconnect', () => { finder.destroy(); process.exit(); });
} else {
  const analysis = path.join(repository, 'analysis');
  await fs.mkdir(analysis, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(analysis, 'search-benchmark-'));
  assert.equal(path.dirname(scratch), analysis);
  let child;
  try {
    const root = process.argv[2] ? await fs.realpath(process.argv[2]) : path.join(scratch, 'project');
    const hit = process.argv[3] || 'NOTCH_SEARCH_BENCHMARK_NEEDLE_739';
    // The old implementation constructs a shell command; benchmark it only with safe inputs.
    assert.match(root, /^[A-Za-z0-9_:/\\.-]+$/, 'The committed baseline needs a shell-safe path without spaces');
    assert.match(hit, /^[A-Za-z0-9_ .-]+$/, 'The committed baseline needs a shell-safe search pattern');
    if (!process.argv[2]) {
      await fs.mkdir(root);
      for (let start = 0; start < 1000; start += 25) {
        await Promise.all(Array.from({ length: 25 }, (_, offset) => {
          const index = start + offset;
          const text = 'export const ordinary = 42;\n'.repeat(128) + (index % 100 === 0 ? hit + '\n' : '');
          return fs.writeFile(path.join(root, `file-${String(index).padStart(5, '0')}.ts`), text);
        }));
      }
    }
    const { transform } = await import('esbuild');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
    const original = execFileSync('git', ['show', `${revision}:vendor/notch-cli/src/tools/grep.ts`], { cwd: repository, encoding: 'utf8', windowsHide: true });
    const compiled = await transform(original, { loader: 'ts', format: 'esm', target: 'node22' });
    const baselineFile = path.join(scratch, 'baseline.mjs');
    await fs.writeFile(baselineFile, compiled.code);
    const baseline = (await import(pathToFileURL(baselineFile).href)).grepTool;
    const current = (await import('../vendor/notch-cli/src/tools/grep.ts')).grepTool;
    const normalize = result => {
      assert.equal(result.isError, undefined, result.content);
      return result.content === '(no matches)' ? [] : result.content.trimEnd().split('\n').map(line => {
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        assert.ok(match, `Unexpected grep output: ${line}`);
        return `${match[1].replace(root + path.sep, '').replaceAll('\\', '/')}:${match[2]}:${match[3]}`;
      }).sort();
    };
    const invoke = async (tool, pattern) => normalize(await tool.execute(tool.parameters.parse({ pattern }), { cwd: root }));
    const coldStart = performance.now();
    child = fork(fileURLToPath(import.meta.url), ['--fff-worker', root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [], windowsHide: true });
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(30000) });
    assert.equal(ready.ready, true);
    assert.ok(ready.files.length > 0);
    if (!process.argv[2]) assert.equal(ready.files.length, 1000);
    const fffColdMs = performance.now() - coldStart;
    const rgFiles = execFileSync('rg', ['--files', root], { cwd: repository, encoding: 'utf8', windowsHide: true }).trimEnd().split('\n').map(file => path.relative(root, file.replace(/\r$/, '')).replaceAll('\\', '/'));
    const indexed = new Set(ready.files), listed = new Set(rgFiles);
    const coverage = { ripgrepFiles: rgFiles.length, fffFiles: indexed.size, missingFromFff: rgFiles.filter(file => !indexed.has(file)), extraInFff: ready.files.filter(file => !listed.has(file)) };
    if (!process.argv[2]) assert.equal(coverage.missingFromFff.length + coverage.extraInFff.length, 0);
    console.log(`File coverage: ripgrep ${coverage.ripgrepFiles}, fff ${coverage.fffFiles}; ${coverage.missingFromFff.length} only in ripgrep, ${coverage.extraInFff.length} only in fff`);
    let fffRssMiB = ready.rssMiB;
    const fff = async pattern => {
      const reply = once(child, 'message', { signal: AbortSignal.timeout(15000) });
      child.send({ pattern });
      const [result] = await reply;
      fffRssMiB = Math.max(fffRssMiB, result.rssMiB);
      return result.rows;
    };
    const cases = [{ name: 'hit', pattern: hit }, { name: 'miss', pattern: 'NOTCH_SEARCH_BENCHMARK_MISSING_739' }];
    const engines = { before: pattern => invoke(baseline, pattern), after: pattern => invoke(current, pattern), fff };
    const results = [];
    for (const scenario of cases) {
      const expected = await engines.after(scenario.pattern);
      if (scenario.name === 'hit') assert.ok(expected.length > 0, 'Choose a hit pattern present in this workspace');
      else assert.equal(expected.length, 0);
      for (const [engine, run] of Object.entries(engines)) {
        for (let warmup = 0; warmup < 2; warmup++) assert.deepEqual(await run(scenario.pattern), expected);
        const runs = [];
        for (let sample = 0; sample < 9; sample++) {
          let previous = performance.now(), maxGap = 0;
          const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }, 5);
          const started = performance.now();
          try {
            const rows = await run(scenario.pattern);
            const wallMs = performance.now() - started;
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.deepEqual(rows, expected);
            runs.push({ wallMs, eventLoopDelayMs: Math.max(0, maxGap - 5) });
          } finally { clearInterval(timer); }
        }
        const walls = runs.map(run => run.wallMs).sort((a, b) => a - b);
        const row = { scenario: scenario.name, engine, matches: expected.length, medianMs: walls[4], p95Ms: walls[8], maxEventLoopDelayMs: Math.max(...runs.map(run => run.eventLoopDelayMs)), runs };
        results.push(row);
        console.log(`${scenario.name} ${engine}: median ${row.medianMs.toFixed(2)} ms, p95 ${row.p95Ms.toFixed(2)} ms, event-loop delay ${row.maxEventLoopDelayMs.toFixed(2)} ms`);
      }
    }
    const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, root, hitPattern: hit, coverage, fixtureFiles: process.argv[2] ? null : 1000, method: 'Serial warm-cache runs; 2 warmups, 9 samples per case; every result checked against async ripgrep; fff latency includes worker IPC; 5 ms parent heartbeat. p95 is the maximum of 9 samples.', baseline: `${revision}:vendor/notch-cli/src/tools/grep.ts`, fffColdMs, fffRssMiB, memoryNote: 'fff RSS is sampled worker memory, not peak. Parent and transient ripgrep process memory are not compared.', results };
    const reportFile = path.join(analysis, `search-benchmark-${Date.now()}.json`);
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(`fff cold start/index/warmup ${fffColdMs.toFixed(2)} ms; sampled worker RSS ${fffRssMiB.toFixed(2)} MiB\nReport: ${reportFile}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
