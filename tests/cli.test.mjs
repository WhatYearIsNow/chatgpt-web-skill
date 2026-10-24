import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, validateOptions, main } from '../lib/cli.mjs';

const noFiles = { readFile: async () => 'prompt', stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
test('parser rejects unknown, duplicate, missing-value and unsupported command options', () => {
  for (const args of [['image','--candidates'], ['ask','--unknown'], ['ask','--zip','file.zip'],
    ['ask','--prompt','a','--prompt','b'], ['ask','--prompt','x','extra'], ['other']]) assert.throws(() => parseArgs(args), { code: 'USAGE' });
});
test('parser supports repeated refs, a legacy keep-tab alias, and wrapper commands', () => {
  const args = parseArgs(['--prompt','p','--out','o.png','--ref','one.png','--ref','two.png','--keep-tab'], 'image');
  assert.deepEqual(args.ref, ['one.png','two.png']);
  assert.equal(args['keep-tab'], true);
});
test('invalid numbers, conflicting prompt sources, empty prompts and malformed URLs are rejected', async () => {
  for (const args of [ ['ask','--prompt',' '], ['ask','--prompt','x','--prompt-file','q.txt'],
    ['ask','--prompt','x','--timeout','Infinity'], ['image','--prompt','x','--out','x.png','--candidates','NaN'],
    ['image','--prompt','x','--out','x.png','--candidates','0'], ['image','--prompt','x','--out','x.svg'],
    ['followup','--prompt','x','--url','https://chatgpt.com.evil/c/id'], ['account','--provider','email'] ])
    await assert.rejects(validateOptions(parseArgs(args), noFiles), { code: 'USAGE' });
});
test('missing inputs and a directory as output are usage errors before any browser connection', async () => {
  await assert.rejects(validateOptions(parseArgs(['ask','--prompt-file','missing.txt']), { ...noFiles,
    readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), { code: 'USAGE' });
  await assert.rejects(validateOptions(parseArgs(['ask','--prompt','x','--out','directory']), { ...noFiles,
    stat: async () => ({ isFile: () => false }) }), { code: 'USAGE' });
  await assert.rejects(validateOptions(parseArgs(['review','--prompt','x','--zip','missing.zip']), noFiles), { code: 'USAGE' });
});
test('one JSON result on stdout and stable exit codes for command failures', async () => {
  for (const [error, expectedCode] of [
    [Object.assign(new Error('unknown send'), { taskState: { sent: 'unknown' }, code: 'SEND_UNCONFIRMED' }), 4],
    [Object.assign(new Error('quota'), { name: 'QuotaError' }), 3], [new Error('other'), 1]]) {
    const output = []; let exitCode;
    await main('ask', { argv: ['--prompt','Test'], stdout: line => output.push(line), setExitCode: value => { exitCode = value; },
      execute: async () => { throw error; } });
    assert.equal(output.length, 1);
    assert.equal(JSON.parse(output[0]).ok, false);
    assert.equal(exitCode, expectedCode);
  }
});
test('help/version and invalid arguments execute through real ESM subprocesses without a browser', () => {
  for (const command of ['ask','review','image','followup','account','quota']) {
    const entry = fileURLToPath(new URL(`../scripts/${command}.mjs`, import.meta.url));
    const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, CHATGPT_WEB_CDP_URL: '', CHATGPT_WEB_BROWSER_MODULE: '' } });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /chatgpt-web 0\.2\.0/);
    const bad = spawnSync(process.execPath, [entry, '--unknown'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(bad.status, 2, bad.stderr);
    assert.equal(JSON.parse(bad.stdout).error.code, 'USAGE');
  }
});
test('main success uses the validated task service without reading a real ledger', async () => {
  const output = [];
  await main('ask', { argv: ['--prompt','Test'], stdout: line => output.push(line),
    execute: async options => ({ ok: true, command: options.command, sent: true }) });
  assert.equal(JSON.parse(output[0]).ok, true);
});

test('Google may reuse its existing session, while email SSO still requires a target', async () => {
  const result = await validateOptions(parseArgs(['account','--google']));
  assert.equal(result.provider, 'google');
  assert.equal(result.email, undefined);
});
