const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'controller.ts'), 'utf8');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: exportsObject });
const { controllerNeighbour } = exportsObject;
const cell = (id,x,w) => ({ m: { id }, x, w });
const rows = [
  { kind: 'row', y: 50, h: 100, cells: [cell(1,0,100),cell(2,104,200)] },
  { kind: 'header', y: 154, h: 52 },
  { kind: 'row', y: 206, h: 150, cells: [cell(3,0,140),cell(4,144,160)] },
];
const layout = { blocks: rows };
test('moves horizontally within a justified row, respecting unequal widths', () => {
  assert.equal(controllerNeighbour(layout,1,'ArrowRight'),2);
  assert.equal(controllerNeighbour(layout,2,'ArrowLeft'),1);
});
test('moves vertically to the closest image across date headers', () => {
  assert.equal(controllerNeighbour(layout,1,'ArrowDown'),3);
  assert.equal(controllerNeighbour(layout,4,'ArrowUp'),2);
});
test('does not wrap at the first or last row', () => {
  assert.equal(controllerNeighbour(layout,1,'ArrowUp'),undefined);
  assert.equal(controllerNeighbour(layout,4,'ArrowDown'),undefined);
});
test('navigates the virtual layout even when the next row is not mounted', () => {
  const many = { blocks: Array.from({length:100},(_,i)=>({kind:'row',y:i*200,h:180,cells:[cell(i+1,0,300)]})) };
  assert.equal(controllerNeighbour(many,75,'ArrowDown'),76);
  assert.equal(controllerNeighbour(many,75,'ArrowUp'),74);
});
test('handles empty and replaced collections', () => {
  assert.equal(controllerNeighbour({blocks:[]},1,'ArrowDown'),undefined);
  assert.equal(controllerNeighbour(layout,999,'ArrowDown'),1);
});
test('never skips the adjacent row for a better aligned tile farther away', () => {
  const scene = { blocks: [
    { kind: 'row', y: 0, h: 200, cells: [cell(1,0,356),cell(2,360,150)] },
    { kind: 'header', y: 204, h: 60 },
    { kind: 'row', y: 264, h: 200, cells: [cell(3,0,495),cell(4,499,264)] },
    { kind: 'row', y: 468, h: 232, cells: [cell(5,0,356),cell(6,360,356)] },
  ] };
  assert.equal(controllerNeighbour(scene,1,'ArrowDown'),3);
  assert.equal(controllerNeighbour(scene,5,'ArrowUp'),3);
});
test('horizontal movement stops at the row boundary even if another row has a candidate', () => {
  assert.equal(controllerNeighbour(layout,2,'ArrowRight'),undefined);
  assert.equal(controllerNeighbour(layout,3,'ArrowLeft'),undefined);
});
