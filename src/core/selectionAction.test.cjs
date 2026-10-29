const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, 'selectionAction.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: exportsObject });
const { selectionActionIds } = exportsObject;
test('contextual archive and unarchive keep the three selected IDs after selection is cleared', () => {
  const selected = new Set([11, 12, 13]);
  const ids = selectionActionIds(selected, 12);
  selected.clear();
  assert.deepEqual([...ids], [11, 12, 13]);
});
test('context outside the selection remains an individual action', () => {
  assert.deepEqual([...selectionActionIds(new Set([11, 12]), 13)], [13]);
});
test('device-only IDs are excluded from vault batches', () => {
  assert.deepEqual([...selectionActionIds(new Set([-1, 11, 12]), 11)], [11, 12]);
});
