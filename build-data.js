const fs = require('fs');
const path = require('path');

const root = __dirname;
const meta = JSON.parse(fs.readFileSync(path.join(root, 'data', 'meta.json'), 'utf8'));
const sourceChapters = meta.chapters.map(({ ch }) => {
  const file = path.join(root, 'data', `chapter-${String(ch).padStart(2, '0')}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
});

// 两章合并为一章：40 章 -> 20 章
const chapters = [];
for (let i = 0; i < sourceChapters.length; i += 2) {
  chapters.push([...sourceChapters[i], ...(sourceChapters[i + 1] || [])]);
}
const chapterMeta = chapters.map((words, index) => ({ ch: index + 1, count: words.length }));

const output = `/* Generated from data/*.json. Embedded so index.html works when opened directly. */\nwindow.WORD_MEMORY_DATA = ${JSON.stringify({ chapters, meta: chapterMeta })};\n`;
fs.writeFileSync(path.join(root, 'data.js'), output, 'utf8');
console.log(`data.js: ${chapters.length} chapters, ${chapters.flat().length} words, ${Buffer.byteLength(output)} bytes`);
console.log(`chapter sizes: ${chapterMeta.map(m => m.count).join(', ')}`);
