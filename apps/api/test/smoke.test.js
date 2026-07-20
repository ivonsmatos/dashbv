import test from 'node:test';
import assert from 'node:assert/strict';
test('runtime supports fetch and crypto',()=>{ assert.equal(typeof fetch,'function'); assert.equal(typeof crypto,'object'); });

