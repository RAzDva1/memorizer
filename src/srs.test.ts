import assert from 'node:assert/strict';
import { createInitialSrs, isDue, reviewCard } from './srs';

const at = new Date('2026-05-27T10:00:00.000Z');
const initial = createInitialSrs();

const hard = reviewCard(initial, false, at);
assert.equal(hard.reviewCount, 0);
assert.equal(hard.intervalDays, 0);
assert.equal(hard.dueAt, at.toISOString());
assert.equal(isDue(hard, at), true);

const remembered = reviewCard(initial, true, at);
assert.equal(remembered.reviewCount, 1);
assert.equal(remembered.intervalDays, 1);
assert.equal(isDue(remembered, at), false);

console.log('srs tests passed');
