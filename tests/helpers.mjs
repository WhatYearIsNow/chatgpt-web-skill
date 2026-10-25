import vm from 'node:vm';
import { SEL } from '../lib/selectors.mjs';

export function fixture({
  users = [],
  assistants = [],
  complete = true,
  stop = false,
  body = '',
  draft = '',
  attachment = false,
} = {}) {
  const element = (spec) => ({
    innerText: spec.text || '',
    textContent: spec.raw ?? spec.text ?? '',
    getAttribute: (key) => (key === 'data-chatgpt-search-unit-key' ? spec.key : null),
    compareDocumentPosition: (other) => (spec.order < other.order ? 4 : 2),
    querySelector: () => (spec.markdown ? { innerText: spec.markdown } : null),
    order: spec.order,
  });
  const userNodes = users.map(element);
  const assistantNodes = assistants.map(element);
  const buttons = stop ? [{ getAttribute: () => 'Stop generating' }] : [];
  const turns = [{ getAttribute: () => (complete ? 'complete' : 'streaming') }];
  const document = {
    body: { innerText: body },
    querySelectorAll(selector) {
      if (selector === SEL.userMsg) return userNodes;
      if (selector === SEL.assistant) return assistantNodes;
      if (selector === SEL.turn) return turns;
      if (selector === 'button') return buttons;
      throw new Error(`夹具没有实现选择器：${selector}`);
    },
    querySelector(selector) {
      if (selector.startsWith('textarea')) return { value: draft };
      if (selector === '[contenteditable="true"]') return null;
      if (selector === SEL.attachChip) return attachment ? {} : null;
      throw new Error(`夹具没有实现选择器：${selector}`);
    },
  };
  return {
    evaluate: async (expression) => vm.runInNewContext(expression, { document }),
    waitForFunction: async (expression) => {
      if (!vm.runInNewContext(expression, { document })) throw new Error('等待条件未满足');
    },
  };
}
