#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { getAllTaskEntries } = require('../utils/bingoTasks');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function main() {
  const entries = getAllTaskEntries()
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const output = entries.reduce((acc, entry) => {
    acc[entry.id] = entry.text;
    return acc;
  }, {});

  const outputDir = path.join(__dirname, '..', 'locales', 'bingo');
  ensureDir(outputDir);
  const outputPath = path.join(outputDir, 'template.en.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Exported ${entries.length} bingo tasks to ${outputPath}`);
}

main();
