import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { runTask } from './tasks.mjs';
import { todayImages, tail } from './quota.mjs';
import { conversationUrl, positiveTimeout } from './conversation.mjs';
import { errorResult, TaskError } from './errors.mjs';
import { browserAction } from './browser-command.mjs';

export const VERSION = '0.3.0';
const COMMANDS = ['ask', 'review', 'followup', 'image', 'quota', 'account', 'browser'];
const BROWSER_ACTIONS = ['status', 'start', 'login', 'stop'];
const FLAGS = new Set([
  'help',
  'version',
  'dry-run',
  'think',
  'keep-open',
  'keep-tab',
  'today',
  'google',
  'headless',
]);
const VALUES = new Set([
  'prompt',
  'prompt-file',
  'out',
  'account',
  'timeout',
  'lock-timeout',
  'url',
  'zip',
  'ref',
  'candidates',
  'tail',
  'email',
  'provider',
  'chrome',
]);
const COMMON = ['help', 'version', 'dry-run', 'keep-open', 'keep-tab', 'timeout', 'lock-timeout'];
const INPUT = ['prompt', 'prompt-file', 'out', 'account', 'think'];
const ALLOWED = {
  ask: [...COMMON, ...INPUT],
  review: [...COMMON, ...INPUT, 'zip'],
  followup: [...COMMON, ...INPUT, 'url'],
  image: [...COMMON, ...INPUT, 'ref', 'candidates'],
  quota: ['help', 'version', 'today', 'tail', 'account'],
  account: [...COMMON, 'email', 'provider', 'google'],
  browser: ['help', 'version', 'headless', 'chrome', 'timeout', 'lock-timeout'],
};
const usage = (message) => new TaskError('USAGE', message);

export function parseArgs(argv, forcedCommand = null) {
  const args = [...argv];
  const command = forcedCommand || (args[0]?.startsWith('--') ? 'ask' : args.shift());
  if (!COMMANDS.includes(command)) throw usage(`Choose a command: ${COMMANDS.join(', ')}`);
  const parsed = { command };
  if (command === 'browser' && args[0] && !args[0].startsWith('--')) parsed.action = args.shift();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw usage(`Unexpected argument: ${args[i]}`);
    const key = args[i].slice(2);
    if (!ALLOWED[command].includes(key)) throw usage(`Unknown option for ${command}: --${key}`);
    if (parsed[key] !== undefined && key !== 'ref') throw usage(`Duplicate option: --${key}`);
    if (FLAGS.has(key)) parsed[key] = true;
    else if (VALUES.has(key)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--'))
        throw usage(`Missing value for --${key}`);
      const value = args[++i];
      if (key === 'ref') (parsed.ref ||= []).push(value);
      else parsed[key] = value;
    }
  }
  return parsed;
}

function integer(value, fallback, min, max, option) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw usage(`--${option} must be an integer from ${min} to ${max}`);
  return n;
}

export async function validateOptions(args, io = { readFile, stat }) {
  const o = {
    command: args.command,
    dryRun: !!args['dry-run'],
    keepOpen: !!(args['keep-open'] || args['keep-tab']),
    think: !!args.think,
    account: args.account,
  };
  if (args.command === 'quota') {
    if (args.today && args.tail !== undefined) throw usage('Use --today or --tail, not both');
    return { ...o, today: !!args.today, tail: integer(args.tail, 20, 1, 10000, 'tail') };
  }
  if (args.command === 'browser') {
    const action = args.action || 'status';
    if (!BROWSER_ACTIONS.includes(action))
      throw usage(`Choose a browser action: ${BROWSER_ACTIONS.join(', ')}`);
    if (action === 'login' && args.headless)
      throw usage('browser login needs a visible window; --headless is not available for login');
    try {
      o.timeoutMs = positiveTimeout(args.timeout, 300);
      o.lockTimeoutMs = positiveTimeout(args['lock-timeout'], 600);
    } catch (error) {
      throw usage(error.message);
    }
    return { ...o, action, headless: !!args.headless, chrome: args.chrome || null };
  }
  try {
    o.timeoutMs = positiveTimeout(
      args.timeout,
      args.command === 'ask' ? 300 : args.command === 'image' ? 200 : 900,
    );
    o.lockTimeoutMs = positiveTimeout(args['lock-timeout'], 600);
  } catch (error) {
    throw usage(error.message);
  }
  if (args.command === 'account') {
    if (args.google && args.provider) throw usage('Use --google or --provider, not both');
    o.provider = args.google ? 'google' : args.provider || 'email';
    if (!['email', 'google'].includes(o.provider)) throw usage('--provider must be email or google');
    if (
      (!args.email && o.provider !== 'google') ||
      (args.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email))
    )
      throw usage('Email SSO requires --email; Google may reuse its existing session without a target email');
    return { ...o, email: args.email };
  }
  if ((args.prompt !== undefined) === (args['prompt-file'] !== undefined))
    throw usage('Provide exactly one of --prompt or --prompt-file');
  try {
    o.prompt = args['prompt-file'] ? await io.readFile(resolve(args['prompt-file']), 'utf8') : args.prompt;
  } catch (error) {
    throw usage(`Cannot read prompt file (${error.code || 'I/O error'})`);
  }
  if (!o.prompt?.trim()) throw usage('Prompt cannot be empty');
  o.out = args.out
    ? resolve(args.out)
    : args.command === 'review' || args.command === 'followup'
      ? resolve(`chatgpt-${args.command}-${Date.now()}.md`)
      : null;
  if (args.command === 'followup') {
    try {
      o.url = conversationUrl(args.url);
    } catch (error) {
      throw usage(error.message);
    }
  }
  const file = async (path) => {
    let info;
    try {
      info = path && (await io.stat(resolve(path)));
    } catch (error) {
      throw usage(`Cannot read attachment (${error.code || 'I/O error'})`);
    }
    if (!info?.isFile()) throw usage('Attachment must be an existing regular file');
    return resolve(path);
  };
  if (args.command === 'review') {
    if (!args.zip || extname(args.zip).toLowerCase() !== '.zip')
      throw usage('review requires --zip pointing to a ZIP file');
    o.zip = await file(args.zip);
  }
  if (args.command === 'image') {
    if (!o.out || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(o.out).toLowerCase()))
      throw usage('image requires --out with .png, .jpg or .webp extension');
    o.candidates = integer(args.candidates, 1, 1, 20, 'candidates');
    o.refs = await Promise.all((args.ref || []).map(file));
  }
  if (o.out) {
    const outputs =
      args.command === 'image' && o.candidates > 1
        ? Array.from({ length: o.candidates }, (_, i) => {
            const extension = extname(o.out);
            return o.out.slice(0, -extension.length) + `-${i + 1}` + extension;
          })
        : [o.out];
    for (const out of outputs) {
      try {
        if (!(await io.stat(out)).isFile()) throw usage('Output path exists and is not a regular file');
      } catch (error) {
        if (error.code !== 'ENOENT')
          throw error.code === 'USAGE'
            ? error
            : usage(`Cannot inspect output (${error.code || 'I/O error'})`);
      }
    }
  }
  return o;
}

export function help(command = 'ask') {
  return (
    `chatgpt-web ${VERSION}\nCommands: ${COMMANDS.join(', ')}\n\n` +
    `node scripts/chatgpt-web.mjs ${command} [options]\n` +
    `ask       --prompt TEXT | --prompt-file FILE [--out FILE]\n` +
    `review    --zip FILE --prompt-file FILE [--out FILE]\n` +
    `followup  --url https://chatgpt.com/c/ID --prompt TEXT [--out FILE]\n` +
    `image     --prompt-file FILE --out FILE [--ref FILE ...] [--candidates 1..20]\n` +
    `account   --email ADDRESS [--provider email|google] | --google\n` +
    `browser   status | start [--headless] [--chrome PATH] | login | stop\n` +
    `quota     --today [--account LABEL] | --tail N\n\n` +
    `Task options: --dry-run --keep-open (--keep-tab alias) --timeout SECONDS --lock-timeout SECONDS\n` +
    `Text/image options: --think --account DISPLAY_NAME_FRAGMENT (advisory, not email identity)\n` +
    `--dry-run prepares a real browser composer, INCLUDING uploading specified attachments, but never sends a message.\n` +
    `With no CHATGPT_WEB_CDP_URL or CHATGPT_WEB_BROWSER_MODULE configured, an isolated managed browser\n` +
    `is launched automatically (own profile under the private data directory; log in once, it persists).\n` +
    `Runtime records live outside the package.\n`
  );
}

export async function main(
  forcedCommand = null,
  {
    argv = process.argv.slice(2),
    stdout = (text) => console.log(text),
    setExitCode = (code) => {
      process.exitCode = code;
    },
    execute = runTask,
    browser = browserAction,
    io,
    quota = { todayImages, tail },
  } = {},
) {
  try {
    const args = parseArgs(argv, forcedCommand);
    if (args.help) {
      stdout(help(args.command));
      return;
    }
    if (args.version) {
      stdout(VERSION);
      return;
    }
    const options = await validateOptions(args, io);
    const result =
      options.command === 'quota'
        ? {
            ok: true,
            command: 'quota',
            ...(options.today
              ? { images: await quota.todayImages(options.account) }
              : { events: await quota.tail(options.tail) }),
          }
        : options.command === 'browser'
          ? { ok: true, command: 'browser', ...(await browser(options)) }
          : await execute(options);
    stdout(JSON.stringify(result, null, 2));
  } catch (error) {
    const code =
      error.code === 'USAGE'
        ? 2
        : error.name === 'QuotaError'
          ? 3
          : error.taskState?.sent === 'unknown'
            ? 4
            : 1;
    stdout(JSON.stringify({ ok: false, ...error.taskState, error: errorResult(error) }, null, 2));
    setExitCode(code);
  }
}
