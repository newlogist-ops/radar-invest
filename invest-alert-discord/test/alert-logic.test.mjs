import test from 'node:test';
import assert from 'node:assert/strict';
import { average, shouldAlert } from '../check.mjs';

test('só alerta quando o preço está abaixo da média', () => {
  assert.equal(shouldAlert(9, 10, null, 1), true);
  assert.equal(shouldAlert(10, 10, null, 1), false);
  assert.equal(shouldAlert(11, 10, null, 1), false);
});

test('repete só depois de cair pelo percentual configurado', () => {
  assert.equal(shouldAlert(9, 10, 9, 1), false);
  assert.equal(shouldAlert(8.91, 10, 9, 1), true);
});

test('calcula a média aritmética dos fechamentos', () => {
  assert.equal(average([8, 10, 12]), 10);
});
