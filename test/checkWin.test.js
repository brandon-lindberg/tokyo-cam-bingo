const assert = require('assert');
const { checkWin } = require('../utils/checkWin');

function testVSModeHandlesEmptyArray() {
  const result = checkWin([], ['row'], { isVSMode: true });
  assert.strictEqual(result.won, false, 'Empty VS stamps should not trigger a win');
  assert.strictEqual(result.condition, null, 'Empty VS stamps should not report a condition');
}

function testVSModeRowWin() {
  const squares = Array.from({ length: 5 }, (_, col) => ({ row: 0, col }));
  const result = checkWin(squares, ['row'], { isVSMode: true });
  assert.strictEqual(result.won, true, 'Full VS row should trigger a win');
  assert.strictEqual(result.condition, 'Row', 'VS row win should return Row condition');
}

function testVSModeCustomBoardSize() {
  const size = 7;
  const squares = Array.from({ length: size }, (_, col) => ({ row: 3, col }));
  const result = checkWin(squares, ['row'], { isVSMode: true, boardSize: size });
  assert.strictEqual(result.won, true, 'VS row win should respect custom board size');
  assert.strictEqual(result.condition, 'Row', 'VS row win should still report Row condition');
}

function testRegularModeRowWin() {
  const card = Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 5 }, (_, col) => ({
      item: `Tile ${row}-${col}`,
      stamped: row === 1
    }))
  );
  const result = checkWin(card, ['row'], { isVSMode: false });
  assert.strictEqual(result.won, true, 'Stamped regular row should trigger a win');
  assert.strictEqual(result.condition, 'Row', 'Regular row win should return Row condition');
}

function testRegularModeDiagonalOnLargerBoard() {
  const size = 6;
  const card = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => ({
      item: `Tile ${row}-${col}`,
      stamped: col === size - 1 - row
    }))
  );
  const result = checkWin(card, ['diagonals'], { isVSMode: false, boardSize: size });
  assert.strictEqual(result.won, true, 'Anti-diagonal win should work on larger boards');
  assert.strictEqual(result.condition, 'Diagonals', 'Diagonal win should report Diagonals');
}

function testRegularModeHandlesSparseData() {
  const card = [
    [{ item: 'A', stamped: false }],
    null,
    undefined,
    [{ item: 'B', stamped: false }, { item: 'C', stamped: true }],
    []
  ];
  const result = checkWin(card, ['row'], { isVSMode: false });
  assert.strictEqual(result.won, false, 'Sparse regular card should not crash or report win');
  assert.strictEqual(result.condition, null, 'Sparse regular card should not report condition');
}

function testRegularModeEmptyCard() {
  const result = checkWin([], ['row'], { isVSMode: false });
  assert.strictEqual(result.won, false, 'Empty regular card should not trigger a win');
  assert.strictEqual(result.condition, null, 'Empty regular card should not report condition');
}

function run() {
  testVSModeHandlesEmptyArray();
  testVSModeRowWin();
  testVSModeCustomBoardSize();
  testRegularModeRowWin();
  testRegularModeDiagonalOnLargerBoard();
  testRegularModeHandlesSparseData();
  testRegularModeEmptyCard();
  console.log('All checkWin tests passed');
}

run();
