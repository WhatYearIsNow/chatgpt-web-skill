import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, parse, join, basename, extname } from 'node:path';
import * as web from './chatgpt.mjs';
import { Page } from './browser.mjs';
import { acquireLock } from './lock.mjs';
import * as quota from './quota.mjs';
import { assertIdleComposer, conversationUrl } from './conversation.mjs';
import { TaskError } from './errors.mjs';

export function normalizeTaskOptions(input) {
  const invalid = (message) => {
    throw new TaskError('USAGE', message);
  };
  if (
    !input ||
    typeof input !== 'object' ||
    !['ask', 'review', 'followup', 'image', 'account'].includes(input.command)
  )
    invalid('Invalid task command');
  const o = {
    timeoutMs: input.command === 'ask' ? 300000 : input.command === 'image' ? 200000 : 900000,
    lockTimeoutMs: 600000,
    candidates: 1,
    refs: [],
    dryRun: false,
    keepOpen: false,
    think: false,
    ...input,
  };
  for (const key of ['timeoutMs', 'lockTimeoutMs'])
    if (!Number.isInteger(o[key]) || o[key] < 1 || o[key] > 2147483647)
      invalid(`${key} must be a positive integer within timer bounds`);
  for (const key of ['dryRun', 'keepOpen', 'think'])
    if (typeof o[key] !== 'boolean') invalid(`${key} must be a boolean`);
  if (o.out != null && (typeof o.out !== 'string' || !o.out.trim())) invalid('Invalid output path');
  if (o.command === 'account') {
    if (
      (!o.email && o.provider !== 'google') ||
      (o.email && (typeof o.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email))) ||
      !['email', 'google'].includes(o.provider)
    )
      invalid('Account requires email SSO with an exact email or existing Google SSO');
  } else if (typeof o.prompt !== 'string' || !o.prompt.trim()) invalid('Task requires a nonempty prompt');
  if (o.command === 'followup') {
    try {
      o.url = conversationUrl(o.url);
    } catch (error) {
      invalid(error.message);
    }
  }
  if (o.command === 'review' && (typeof o.zip !== 'string' || extname(o.zip).toLowerCase() !== '.zip'))
    invalid('Review requires a ZIP path');
  if (o.command === 'image') {
    if (!Number.isInteger(o.candidates) || o.candidates < 1 || o.candidates > 20)
      invalid('Candidates must be an integer from 1 to 20');
    if (!o.out || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(o.out).toLowerCase()))
      invalid('Image output needs a supported extension');
    if (!Array.isArray(o.refs) || o.refs.some((path) => typeof path !== 'string' || !path.trim()))
      invalid('References must be file path strings');
  }
  return o;
}

export function dependencies(overrides = {}) {
  return {
    ...web,
    ...quota,
    acquireLock,
    Page,
    assertIdleComposer,
    writeFile,
    mkdir,
    switchAccount: async (...args) => (await import('./account.mjs')).switchAccount(...args),
    ...overrides,
  };
}

function candidatePath(path, index, count) {
  if (count === 1) return path;
  const parts = parse(path);
  return join(parts.dir, `${parts.name}-${index}${parts.ext}`);
}

/** One command transaction. External sends never retry; all tabs belong to this transaction. */
export async function runTask(options, overrides = {}) {
  options = normalizeTaskOptions(options);
  const d = dependencies(overrides);
  const { command } = options;
  const state = { command, stage: 'lock', sent: false, url: null, outputs: [], warnings: [] };
  let release;
  let context;
  let account = null;
  async function ledger(outcome, notes = null) {
    try {
      await d.record({ cmd: command, kind: command, account, outcome, ...(notes ? { notes } : {}) });
    } catch (error) {
      state.warnings.push({ code: 'LEDGER_WRITE_FAILED', message: error.message });
    }
  }
  async function closeContext() {
    if (!context) return;
    const owned = context;
    context = null;
    try {
      if (!options.keepOpen) {
        if (owned.disconnected || owned.cdp.closed) await d.closeTab(owned.targetId);
        else if (typeof owned.page.close === 'function') await owned.page.close();
        else await owned.cdp.call('Target.closeTarget', { targetId: owned.targetId });
      }
    } catch (error) {
      state.warnings.push({ code: 'TAB_CLOSE_FAILED', message: error.message });
    } finally {
      try {
        owned.cdp.close();
      } catch {}
    }
  }
  try {
    release = await d.acquireLock(command, { timeoutMs: options.lockTimeoutMs });
    const count = command === 'image' && !options.dryRun ? options.candidates : 1;
    if (command === 'image') state.plannedCandidates = options.candidates;
    for (let index = 1; index <= count; index++) {
      state.stage = 'connect';
      state.sent = false;
      const cdp = await d.connectWithApproval({ timeoutMs: 30000 });
      let targetId;
      try {
        targetId = await cdp.createTarget(options.url || 'https://chatgpt.com/');
        context = { cdp, targetId, page: new d.Page(cdp, targetId) };
      } catch (error) {
        if (targetId) await cdp.call('Target.closeTarget', { targetId }).catch(() => {});
        cdp.close();
        throw error;
      }
      context.sid = await cdp.session(context.targetId);
      await d.activatePage(cdp, context.targetId, context.sid);
      state.stage = 'prepare';
      if (command === 'account') {
        if (options.dryRun)
          state.accountChange = { requestedEmail: options.email, provider: options.provider, applied: false };
        else {
          state.stage = 'account';
          state.accountChange = {
            requestedEmail: options.email,
            provider: options.provider,
            applied: 'unknown',
          };
          state.accountChange = await d.switchAccount(context.page, cdp, context.sid, {
            email: options.email,
            provider: options.provider,
            timeoutMs: options.timeoutMs,
            log: d.log,
          });
          account = state.accountChange.email;
        }
        state.url = await d.currentUrl(context.page);
        await ledger(options.dryRun ? 'dry-run' : 'ok');
        await closeContext();
        continue;
      }
      await d.ensureNetworkAndLogin(context.page, cdp, context.sid);
      await d.waitComposerReady(context.page, cdp, context.sid);
      const assertConversation = async () => {
        if (command !== 'followup') return;
        let current;
        try {
          current = conversationUrl(await d.currentUrl(context.page));
        } catch {}
        if (current !== options.url)
          throw new TaskError(
            'CONVERSATION_UNAVAILABLE',
            'The requested conversation redirected or is unavailable. No follow-up was sent.',
          );
      };
      await assertConversation();
      await d.assertIdleComposer(context.page);
      account = await d.readAccount(context.page, cdp, context.sid);
      d.checkAccount(account, options.account);
      if (command === 'image') {
        const usable = account ? await d.checkUsable(account) : { ok: true };
        if (!usable.ok)
          throw new d.QuotaError(
            `Account has a recorded quota limit until ${usable.resets_at || 'an unknown time'}`,
          );
      }
      if (options.think) await d.setThinking(context.page, cdp, context.sid, { on: true });
      await assertConversation();
      await d.assertIdleComposer(context.page);
      // Owned composer is verified empty before any attachment; fillPrompt never removes chips.
      const attachments = command === 'review' ? [options.zip] : options.refs || [];
      if (attachments.length)
        await d.attachFiles(context.page, cdp, context.sid, attachments, {
          kind: command === 'review' ? 'files' : 'photos',
        });
      await d.fillPrompt(context.page, cdp, context.sid, options.prompt, {
        beforeAttempt: assertConversation,
      });
      await assertConversation();
      state.url = await d.currentUrl(context.page);
      if (options.dryRun) {
        await ledger('dry-run');
        await closeContext();
        continue;
      }
      state.stage = 'send';
      // A transport error during the send is also ambiguous: never silently call it unsent.
      state.sent = 'unknown';
      const replyTo = await d.sendAndConfirm(context.page);
      state.sent = true;
      const replyDeadline = performance.now() + options.timeoutMs;
      const remaining = () => {
        const ms = Math.ceil(replyDeadline - performance.now());
        if (ms <= 0)
          throw new TaskError(
            'REPLY_TIMEOUT',
            'Reply waiting and collection exceeded the configured timeout',
          );
        return ms;
      };
      await d.waitConvUrl(context.page, { timeoutMs: Math.min(30000, remaining()) });
      state.url = await d.currentUrl(context.page);
      state.stage = 'wait';
      if (command === 'image') {
        const out = candidatePath(options.out, index, count);
        cdp.close();
        context.disconnected = true;
        const next = await d.attach(context.targetId, { timeoutMs: Math.min(25000, remaining()) });
        context = { ...next, targetId: context.targetId };
        const completedUrl = await d.waitAndSaveImage(context.page, out, remaining(), { replyTo });
        if (completedUrl) state.url = completedUrl;
        state.outputs.push({ out });
        if (account) {
          try {
            await d.markOk(account);
          } catch (error) {
            state.warnings.push({ code: 'QUOTA_WRITE_FAILED', message: error.message });
          }
        }
      } else {
        await d.waitTurnComplete(context.page, remaining(), { replyTo });
        const reply = await d.collectReply(context.page, { replyTo, waitContentMs: remaining() });
        state.stage = 'save';
        if (options.out) {
          await d.mkdir(dirname(options.out), { recursive: true });
          const header = `# ChatGPT reply\n\n- Conversation: ${state.url}\n- Collected: ${new Date().toISOString()}\n\n---\n\n`;
          await d.writeFile(options.out, header + reply.text, { encoding: 'utf8', mode: 0o600 });
          state.outputs.push({ out: options.out, chars: reply.text.length });
        } else state.outputs.push({ text: reply.text, chars: reply.text.length });
      }
      if (state.url?.includes('/c/local-chatgpt'))
        state.warnings.push({
          code: 'CONVERSATION_TRANSIENT',
          message:
            'The website returned a browser-local conversation URL that may not reopen. Use --keep-open when a new conversation must be continued.',
        });
      await ledger('ok', options.out ? basename(options.out) : null);
      await closeContext();
    }
    state.stage = 'complete';
    return { ok: true, ...state, dryRun: options.dryRun, account };
  } catch (error) {
    if (context) state.url = await d.currentUrl(context.page).catch(() => state.url);
    if (error instanceof d.QuotaError && account) {
      try {
        await d.markExhausted(account, error.rawMessage || error.message);
      } catch (failure) {
        state.warnings.push({ code: 'QUOTA_WRITE_FAILED', message: failure.message });
      }
    }
    if (release) await ledger(error instanceof d.QuotaError ? 'quota-exhausted' : 'fail');
    error.taskState = state;
    throw error;
  } finally {
    await closeContext();
    if (release) {
      try {
        await release();
      } catch (error) {
        state.warnings.push({ code: 'LOCK_RELEASE_FAILED', message: error.message });
      }
    }
  }
}
