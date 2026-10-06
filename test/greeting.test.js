import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greeting.js';

test('greets by name', () => {
  assert.equal(greet('World'), 'Hello, World! Deployed via GitHub Actions.');
});

test('throws without a name', () => {
  assert.throws(() => greet(), /name is required/);
});
