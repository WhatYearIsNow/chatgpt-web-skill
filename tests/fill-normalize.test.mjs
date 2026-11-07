import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFillText } from '../lib/chatgpt.mjs';

test('normalizeFillText: crlf, nbsp, trim', () => {
  assert.equal(normalizeFillText('a\r\nb'), 'a\nb');
  assert.equal(normalizeFillText('a\u00a0b'), 'a b');
  assert.equal(normalizeFillText('  x  '), 'x');
});

test('newline runs collapse to a single newline on both sides', () => {
  assert.equal(normalizeFillText('a\n\n\n\n\nb'), 'a\nb');
  assert.equal(normalizeFillText('a\n\nb'), 'a\nb');
  assert.equal(normalizeFillText('a\nb'), 'a\nb');
});

test('site rendering transforms stay equal under verification', () => {
  const prompt = 'line1\n\nline2';
  const softExpanded = 'line1\n\n\n\nline2';
  const blankDoubled = 'line1\n\n\n\n\nline2';
  const want = normalizeFillText(prompt);
  assert.equal(normalizeFillText(softExpanded), want);
  assert.equal(normalizeFillText(blankDoubled), want);
});

test('stale-draft guard survives relaxed verification', () => {
  const a = 'line1\n\nline2';
  assert.notEqual(normalizeFillText(a), normalizeFillText(a + 'extra'));
});
