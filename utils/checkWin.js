function normalizeRules(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules;
}

function isLikelyVSSquares(cardOrStamps) {
  if (!Array.isArray(cardOrStamps) || cardOrStamps.length === 0) {
    return false;
  }
  const first = cardOrStamps[0];
  return !!first && typeof first === 'object' && !Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'row');
}

function checkWin(cardOrStamps, rules = [], options = {}) {
  const desiredMode = options?.isVSMode;
  const inferredVSMode = isLikelyVSSquares(cardOrStamps);
  let isVSMode;
  if (desiredMode === true) {
    isVSMode = true;
  } else if (desiredMode === false) {
    isVSMode = false;
  } else {
    isVSMode = inferredVSMode;
  }

  const stampedGrid = Array.from({ length: 5 }, () => Array(5).fill(false));

  if (isVSMode) {
    (cardOrStamps || []).forEach(({ row, col }) => {
      if (
        Number.isInteger(row) &&
        Number.isInteger(col) &&
        row >= 0 && row < 5 &&
        col >= 0 && col < 5
      ) {
        stampedGrid[row][col] = true;
      }
    });
  } else {
    const card = Array.isArray(cardOrStamps) ? cardOrStamps : [];
    for (let row = 0; row < 5; row++) {
      const rowData = Array.isArray(card[row]) ? card[row] : [];
      for (let col = 0; col < 5; col++) {
        const tile = rowData[col];
        stampedGrid[row][col] = !!(tile && tile.stamped);
      }
    }
  }

  const safeRules = normalizeRules(rules);

  const stampedRows = stampedGrid.map(row => row.every(cell => cell));
  const rowCount = stampedRows.filter(Boolean).length;

  const stampedColumns = Array(5).fill(true);
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 5; row++) {
      if (!stampedGrid[row][col]) {
        stampedColumns[col] = false;
        break;
      }
    }
  }
  const colCount = stampedColumns.filter(Boolean).length;

  const diagonals = {
    main: stampedGrid.every((row, i) => row[i]),
    anti: stampedGrid.every((row, i) => row[4 - i]),
  };

  const full = stampedGrid.flat().every(cell => cell);

  if (safeRules.includes('row') && rowCount >= 1) return { won: true, condition: 'Row' };
  if (safeRules.includes('2rows') && rowCount >= 2) return { won: true, condition: '2 Rows' };
  if (safeRules.includes('3rows') && rowCount >= 3) return { won: true, condition: '3 Rows' };
  if (safeRules.includes('column') && colCount >= 1) return { won: true, condition: 'Column' };
  if (safeRules.includes('2columns') && colCount >= 2) return { won: true, condition: '2 Columns' };
  if (safeRules.includes('3columns') && colCount >= 3) return { won: true, condition: '3 Columns' };
  if (safeRules.includes('diagonals') && (diagonals.main || diagonals.anti)) return { won: true, condition: 'Diagonals' };
  if (safeRules.includes('full') && full) return { won: true, condition: 'Full Card' };

  return { won: false, condition: null };
}

module.exports = { checkWin };
