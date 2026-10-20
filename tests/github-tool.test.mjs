import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['vendor/notch-cli/src/tools/github.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { githubTool } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const context = { cwd: process.cwd(), confirm: async () => true, log() {} };
let previous;
beforeEach(() => { previous = { fetch: globalThis.fetch, gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN }; process.env.GH_TOKEN = 'fake-preferred'; process.env.GITHUB_TOKEN = 'fake-other'; });
afterEach(() => { globalThis.fetch = previous.fetch; for (const [key, value] of [['GH_TOKEN', previous.gh], ['GITHUB_TOKEN', previous.github]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

test('the IDE GitHub tool uses the effective token and actual default branch', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(url.endsWith('/pulls') ? { number: 1, html_url: 'https://example.invalid/pr/1' } : { default_branch: 'develop' }); };
  const result = await githubTool.execute({ action: 'create_pr', owner: 'company', repo: 'project', title: 'Fixture', head: 'feature' }, context);
  assert.equal(result.isError, undefined);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fake-preferred');
  assert.equal(JSON.parse(calls[1].options.body).base, 'develop');
});

test('the IDE reads beyond a PR-only page when listing issues', async () => {
  globalThis.fetch = async url => url.endsWith('page=1') ? Response.json([{ pull_request: {} }], { headers: { link: '<https://api.github.com/next>; rel="next"' } }) : Response.json([{ number: 2, state: 'open', title: 'Actual issue', labels: [], user: { login: 'user' } }]);
  assert.match((await githubTool.execute({ action: 'list_issues', owner: 'company', repo: 'project' }, context)).content, /Actual issue/);
});

test('stopping an IDE task aborts its in-flight GitHub request', async () => {
  const controller = new AbortController();
  let start; const ready = new Promise(resolve => { start = resolve; });
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason)); start(); });
  const result = githubTool.execute({ action: 'repo_info', owner: 'company', repo: 'project' }, { ...context, abortSignal: controller.signal });
  await ready; controller.abort();
  assert.deepEqual(await result, { content: 'GitHub request cancelled.', isError: true });
});
