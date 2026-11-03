'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE_PREFIX = 'wordMemory_';
const REVIEW_INTERVALS = [20, 60, 540, 1440, 2880, 8640, 44640].map(n => n * 60 * 1000);
const chapterCache = new Map();
const state = {
  chapter: 1,
  words: [],
  meta: [],
  queue: [],
  index: 0,
  stats: {},
  session: { correct: 0, total: 0, reviewCount: 0 },
  wordbook: [],
  mistakes: [],
  schedule: {},
  mode: 'en2zh',
  filter: 'all',
  sessionType: 'chapter',
  studyChapter: 1,
  flipped: false,
  transitioning: false,
  view: 'study',
  listType: 'wordbook',
  spelling: { queue: [], index: 0, correct: 0, total: 0, answered: false },
  shuffle: localStorage.getItem(`${STORAGE_PREFIX}shuffle`) === 'true'
};

let loadToken = 0;
let toastTimer;
let searchTimer;
let audioTimer;

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${key}`)) ?? fallback; }
  catch { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value)); }
  catch { showToast('浏览器存储空间不足，请先导出备份'); }
}
function pythonApi() { return window.pywebview?.api; }
function parseApiResult(result) { return typeof result === 'string' ? JSON.parse(result) : result; }

const Store = {
  async loadChapter(chapter) {
    if (pythonApi()) return pythonApi().get_progress(chapter);
    return readLocal(`progress_${chapter}`, {});
  },
  async saveChapter(chapter, progress) {
    if (pythonApi()) return pythonApi().save_progress(chapter, JSON.stringify(progress));
    writeLocal(`progress_${chapter}`, progress);
  },
  async loadCollection(type) {
    if (pythonApi()) return pythonApi()[type === 'wordbook' ? 'get_wordbook' : 'get_mistakes']();
    return readLocal(type, []);
  },
  async saveCollection(type, words) {
    if (pythonApi()) return pythonApi()[`save_${type}_json`](JSON.stringify(words));
    writeLocal(type, words);
  },
  async loadSchedule() {
    if (pythonApi()) return pythonApi().get_ebbinghaus();
    return readLocal('ebbinghaus', {});
  },
  async updateSchedule(word, correct) {
    if (pythonApi()) return pythonApi().update_ebbinghaus(word, correct);
    const now = Date.now();
    const record = state.schedule[word] || { stage: 0, lastReview: now };
    record.stage = correct ? Math.min((record.stage || 0) + 1, REVIEW_INTERVALS.length - 1) : 0;
    record.lastReview = now;
    record.nextReview = now + REVIEW_INTERVALS[record.stage];
    state.schedule[word] = record;
    writeLocal('ebbinghaus', state.schedule);
  },
  async export() {
    if (pythonApi()) return pythonApi().export_all_data();
    const progress = {};
    state.meta.forEach(({ ch }) => { progress[ch] = readLocal(`progress_${ch}`, {}); });
    return { version: '2.0', exportDate: Date.now(), wordbook: state.wordbook, mistakes: state.mistakes, progress, ebbinghaus: state.schedule };
  },
  async import(data) {
    if (pythonApi()) return parseApiResult(await pythonApi().import_data(JSON.stringify(data)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份内容无效');
    ['wordbook', 'mistakes'].forEach(key => {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`${key} 数据格式无效`);
    });
    ['progress', 'ebbinghaus'].forEach(key => {
      if (data[key] !== undefined && (typeof data[key] !== 'object' || data[key] === null || Array.isArray(data[key]))) throw new Error(`${key} 数据格式无效`);
    });
    if (data.wordbook) writeLocal('wordbook', data.wordbook);
    if (data.mistakes) writeLocal('mistakes', data.mistakes);
    if (data.ebbinghaus) writeLocal('ebbinghaus', data.ebbinghaus);
    if (data.progress) Object.entries(data.progress).forEach(([chapter, progress]) => writeLocal(`progress_${chapter}`, progress));
    return { success: true };
  }
};

function showToast(message) {
  clearTimeout(toastTimer);
  $('#toast span').textContent = message;
  $('#toast').classList.add('show');
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

function embeddedChapters() {
  return window.WORD_MEMORY_DATA?.chapters || null;
}

async function getChapter(chapter) {
  if (chapterCache.has(chapter)) return chapterCache.get(chapter);
  const embedded = embeddedChapters();
  let pairs;
  if (embedded) {
    pairs = embedded[chapter - 1];
    if (!Array.isArray(pairs)) throw new Error(`第 ${chapter} 章词库缺失`);
  } else {
    const response = await fetch(`./data/chapter-${String(chapter).padStart(2, '0')}.json`);
    if (!response.ok) throw new Error(`第 ${chapter} 章词库加载失败`);
    pairs = await response.json();
  }
  const words = pairs.map(([en, zh]) => ({ en, zh }));
  chapterCache.set(chapter, words);
  return words;
}

function shuffled(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function makeQueue(words, resumeStats = state.stats, shuffledMode = state.shuffle) {
  // 每章单词只过一遍：已掌握的词不再出现，其余词各出现一次。
  const remaining = words
    .filter(word => (Number(resumeStats[word.en]?.mastery) || 0) < 3)
    .map(word => ({ ...word, isReview: false }));
  return shuffledMode ? shuffled(remaining) : remaining;
}

function pruneQueueByMastery() {
  const mastered = new Set(state.words.filter(word => masteryOf(word) >= 3).map(word => word.en));
  state.queue = state.queue.filter(word => !mastered.has(word.en));
  if (state.index > state.queue.length) state.index = state.queue.length;
}

const QUEUE_VERSION = 2; // 2 = 每章每词只过一遍

function validProgress(saved) {
  if (!saved || saved.queueVersion !== QUEUE_VERSION) return false;
  if (!Array.isArray(saved.queue) || !saved.queue.length) return false;
  const knownWords = new Set(state.words.map(word => word.en));
  return saved.queue.every(item => item && knownWords.has(item.en)) && Number.isInteger(saved.index) && saved.index >= 0 && saved.index <= saved.queue.length;
}

async function saveProgress() {
  if (state.sessionType !== 'chapter') return;
  const progress = { queueVersion: QUEUE_VERSION, queue: state.queue, index: state.index, wordStats: state.stats, sessionStats: state.session, filter: state.filter, sessionType: state.sessionType };
  try { await Store.saveChapter(state.chapter, progress); }
  catch (error) { console.warn('进度保存失败', error); }
}

async function loadStudy(chapter = state.chapter, { fresh = false, customWords = null, type = 'chapter' } = {}) {
  const token = ++loadToken;
  state.chapter = chapter;
  state.transitioning = false;
  setFlipped(false, true);
  $('#flashcardScene').hidden = false;
  $('#recallActions').hidden = false;
  $('.keyboard-hint').hidden = false;
  $('#finishedCard').hidden = true;
  try {
    const [words, saved] = await Promise.all([getChapter(chapter), Store.loadChapter(chapter)]);
    if (token !== loadToken) return;
    state.sessionType = type;
    state.studyChapter = chapter;
    state.words = customWords || words;
    if (type === 'chapter') {
      state.stats = saved?.wordStats || {};
      state.words.forEach(word => { state.stats[word.en] ||= { mastery: 0, correctCount: 0, wrongCount: 0 }; });
    }
    if (!fresh && !customWords && validProgress(saved)) {
      state.queue = saved.queue;
      state.index = saved.index;
      state.session = { correct: 0, total: 0, reviewCount: 0, ...saved.sessionStats };
      state.filter = saved.filter || 'all';
      state.sessionType = 'chapter';
    } else {
      state.stats = type === 'chapter' ? state.stats : {};
      state.queue = makeQueue(state.words);
      state.index = 0;
      state.session = { correct: 0, total: 0, reviewCount: 0 };
      state.filter = 'all';
    }
    renderChapterList();
    renderStudy();
    if (type === 'chapter') chapterCache.set(`stats_${chapter}`, state.stats);
    await saveProgress();
  } catch (error) {
    console.error(error);
    showToast(error.message || '词库加载失败，请通过本地服务器打开');
  }
}

function currentWord() { return state.queue[state.index]; }
function masteryOf(word) { return Math.max(0, Math.min(3, Number(state.stats[word.en]?.mastery) || 0)); }

function setFlipped(value, instant = false) {
  state.flipped = value;
  const card = $('#flashcard');
  if (instant) card.style.transition = 'none';
  card.classList.toggle('flipped', value);
  card.setAttribute('aria-label', value ? '单词释义，点击或按空格返回' : '单词卡片，点击或按空格查看释义');
  if (instant) requestAnimationFrame(() => { card.style.transition = ''; });
}

function flipCard() {
  if (state.view !== 'study' || state.transitioning || !currentWord()) return;
  setFlipped(!state.flipped);
}

function renderStudy() {
  $('#chapterTag').textContent = `CHAPTER ${String(state.studyChapter).padStart(2, '0')}`;
  $('#spellingSubtitle').textContent = `Chapter ${String(state.studyChapter).padStart(2, '0')} · 根据中文释义拼写英文单词`;
  $('#chapterTotal').textContent = state.words.length;
  $('#breadcrumbCurrent').textContent = '词汇记忆';
  renderCard();
  renderProgress();
}

function renderCard() {
  const word = currentWord();
  if (!word) {
    $('#flashcardScene').hidden = true;
    $('#recallActions').hidden = true;
    $('.keyboard-hint').hidden = true;
    $('#finishedCard').hidden = false;
    const accuracy = state.session.total ? Math.round(state.session.correct / state.session.total * 100) : 0;
    $('#finishedSummary').textContent = `完成 ${state.session.total} 次回忆，认识率 ${accuracy}%。不熟的词，下一轮再见。`;
    $('#sessionCount').textContent = `${state.index} / ${state.queue.length}`;
    $('#sessionProgress').style.width = '100%';
    return;
  }
  const englishFirst = state.mode === 'en2zh';
  $('#promptText').textContent = englishFirst ? word.en : word.zh;
  $('#promptText').classList.toggle('chinese', !englishFirst);
  $('#answerText').textContent = englishFirst ? word.zh : word.en;
  $('#answerText').classList.toggle('english', !englishFirst);
  $('#answerWord').textContent = englishFirst ? word.en : word.zh;
  $('#answerPrompt').textContent = englishFirst ? word.en : word.zh;
  $('#cardKicker').textContent = englishFirst ? 'DO YOU KNOW THIS WORD?' : 'WHICH WORD DOES IT MEAN?';
  $('#speakBtn').hidden = !englishFirst;
  const mastery = masteryOf(word);
  $('#wordStatus').textContent = word.isReview ? '再次见面' : mastery ? '继续熟悉' : '新单词';
  $$('.mastery-dots').forEach(container => [...container.children].forEach((dot, i) => dot.classList.toggle('filled', i < mastery)));
  $('#bookmarkBtn').classList.toggle('active', state.wordbook.some(item => item.en === word.en));
  $('#bookmarkBtn').setAttribute('aria-label', state.wordbook.some(item => item.en === word.en) ? '从生词本移除' : '收藏到生词本');
  $('#sessionCount').textContent = `${state.index + 1} / ${state.queue.length}`;
  $('#sessionProgress').style.width = `${state.index / state.queue.length * 100}%`;
  $('#sessionKind').textContent = state.sessionType === 'wordbook' ? '生词复习' : state.filter === 'mistakes' ? '易错词复习' : state.filter === 'learning' ? '薄弱词复习' : state.shuffle ? '随机学习' : '顺序学习';
  setFlipped(false, true);
}

function renderProgress() {
  const mastered = state.words.filter(word => masteryOf(word) >= 3).length;
  const learning = state.words.filter(word => { const level = masteryOf(word); return level > 0 && level < 3; }).length;
  const fresh = state.words.length - mastered - learning;
  const percentage = state.words.length ? Math.round(mastered / state.words.length * 100) : 0;
  const accuracy = state.session.total ? Math.round(state.session.correct / state.session.total * 100) : null;
  $('#masteredNumber').textContent = mastered;
  $('#learningNumber').textContent = learning;
  $('#freshNumber').textContent = fresh;
  $('#chapterPercent').textContent = `${percentage}%`;
  $('#progressRing').style.setProperty('--progress', `${percentage * 3.6}deg`);
  $('#accuracyNumber').textContent = accuracy === null ? '—' : `${accuracy}%`;
  $('#accuracyBar').style.width = `${accuracy || 0}%`;
}

function renderChapterList() {
  const fragment = document.createDocumentFragment();
  state.meta.forEach(({ ch }) => {
    const saved = chapterCache.get(`stats_${ch}`) || {};
    const button = document.createElement('button');
    button.className = `chapter-item${ch === state.studyChapter ? ' active' : ''}${Object.keys(saved).length ? ' started' : ''}`;
    button.dataset.chapter = ch;
    button.innerHTML = `<span class="chapter-number">${String(ch).padStart(2, '0')}</span><span>Chapter ${String(ch).padStart(2, '0')}</span><i class="chapter-mini-progress"></i>`;
    button.setAttribute('aria-label', `第 ${ch} 章${ch === state.chapter ? '，当前章节' : ''}`);
    fragment.appendChild(button);
  });
  $('#chapterList').replaceChildren(fragment);
}

async function selectChapter(chapter) {
  closeSidebar();
  switchView('study');
  await loadStudy(chapter);
}

async function rateWord(correct) {
  const word = currentWord();
  if (!word || state.transitioning) return;
  state.transitioning = true;
  $('#knownBtn').disabled = true;
  $('#unknownBtn').disabled = true;
  const stats = state.stats[word.en] ||= { mastery: 0, correctCount: 0, wrongCount: 0 };
  stats.mastery = correct ? Math.min(3, masteryOf(word) + 1) : Math.max(0, masteryOf(word) - 1);
  stats[correct ? 'correctCount' : 'wrongCount'] = (stats[correct ? 'correctCount' : 'wrongCount'] || 0) + 1;
  state.session.total++;
  if (correct) state.session.correct++;
  if (word.isReview) state.session.reviewCount++;
  if (!correct) {
    await addMistake(word, false);
  }
  state.index++;
  await Store.updateSchedule(word.en, correct);
  const scene = $('#flashcardScene');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) {
    scene.classList.add(correct ? 'exit-known' : 'exit-unknown');
    await new Promise(resolve => setTimeout(resolve, 90));
  }
  renderCard();
  renderProgress();
  scene.classList.remove('exit-known', 'exit-unknown');
  if (!reduceMotion) {
    scene.classList.add('enter-card');
    setTimeout(() => scene.classList.remove('enter-card'), 170);
  }
  state.transitioning = false;
  $('#knownBtn').disabled = false;
  $('#unknownBtn').disabled = false;
  saveProgress();
}

async function addMistake(word, notify = true) {
  const existing = state.mistakes.find(item => item.en === word.en);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastWrongAt = Date.now();
  } else state.mistakes.push({ en: word.en, zh: word.zh, count: 1, lastWrongAt: Date.now() });
  await Store.saveCollection('mistakes', state.mistakes);
  renderCollectionCounts();
  if (notify) showToast('已加入易错词');
}

async function toggleBookmark() {
  const word = currentWord();
  if (!word) return;
  const saved = state.wordbook.some(item => item.en === word.en);
  state.wordbook = saved ? state.wordbook.filter(item => item.en !== word.en) : [...state.wordbook, { en: word.en, zh: word.zh, addedAt: Date.now() }];
  $('#bookmarkBtn').classList.toggle('active', !saved);
  renderCollectionCounts();
  await Store.saveCollection('wordbook', state.wordbook);
  showToast(saved ? '已从生词本移除' : '已收藏到生词本');
}

function speak(text) {
  if (!('speechSynthesis' in window)) { showToast('当前环境不支持语音朗读'); return; }
  speechSynthesis.cancel();
  clearTimeout(audioTimer);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = .9;
  $('#speakBtn').classList.add('speaking');
  const stop = () => $('#speakBtn').classList.remove('speaking');
  utterance.onend = stop;
  utterance.onerror = stop;
  speechSynthesis.speak(utterance);
  audioTimer = setTimeout(stop, 4000);
}

function switchView(view) {
  state.view = view;
  $$('.view').forEach(element => element.classList.toggle('active', element.id === `${view}View`));
  $$('.nav-item').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#breadcrumbCurrent').textContent = { study: '词汇记忆', wordbook: '单词收藏', spelling: '拼写练习' }[view];
  closeSidebar();
  if (view === 'wordbook') renderWordList();
  if (view === 'spelling') startSpelling();
}

function renderCollectionCounts() {
  $('#wordbookCount').textContent = state.wordbook.length;
  $('#listSavedCount').textContent = state.wordbook.length;
  $('#listMistakeCount').textContent = state.mistakes.length;
}

function renderWordList() {
  renderCollectionCounts();
  const source = state.listType === 'wordbook' ? state.wordbook : state.mistakes;
  const query = $('#listSearchInput').value.trim().toLowerCase();
  const words = source.filter(word => word.en.toLowerCase().includes(query) || word.zh.toLowerCase().includes(query));
  $$('.list-tabs button').forEach(button => button.classList.toggle('active', button.dataset.list === state.listType));
  $('#wordbookSubtitle').textContent = state.listType === 'wordbook' ? `共收藏 ${state.wordbook.length} 个词，给它们多一点时间。` : `共 ${state.mistakes.length} 个易错词，拼写错误与“不认识”会出现在这里。`;
  $('#studyWordbookBtn').innerHTML = `${state.listType === 'wordbook' ? '练习生词' : '复习易错词'}<svg><use href="#i-arrow"/></svg>`;
  $('#studyWordbookBtn').disabled = source.length === 0;
  if (!words.length) {
    $('#wordList').innerHTML = `<div class="empty-state"><svg><use href="#i-bookmark"/></svg><h3>${query ? '没有找到匹配的单词' : state.listType === 'wordbook' ? '生词本还是空的' : '暂时没有易错词'}</h3><p>${query ? '换一个关键词试试。' : state.listType === 'wordbook' ? '背词时点击卡片右上角的书签，把单词留在这里。' : '标记“不认识”或拼写错误后，单词会自动记录在这里。'}</p>${query ? '' : '<button class="secondary-btn" id="emptyStudyBtn">去背一组单词<svg><use href="#i-arrow"/></svg></button>'}</div>`;
    $('#emptyStudyBtn')?.addEventListener('click', () => switchView('study'));
    return;
  }
  const fragment = document.createDocumentFragment();
  words.forEach((word, index) => {
    const row = document.createElement('article');
    row.className = 'word-row';
    row.style.animationDelay = `${Math.min(index, 12) * 25}ms`;
    const main = document.createElement('div');
    main.className = 'word-row-main';
    const en = document.createElement('strong');
    en.textContent = word.en;
    const zh = document.createElement('p');
    zh.textContent = word.zh;
    main.append(en, zh);
    const meta = document.createElement('span');
    meta.className = 'word-row-meta';
    meta.textContent = state.listType === 'mistakes' ? `错 ${word.count || 1} 次` : '已收藏';
    const actions = document.createElement('div');
    actions.className = 'word-row-actions';
    actions.innerHTML = `<button class="icon-btn speak-row" aria-label="朗读 ${word.en}" title="朗读"><svg><use href="#i-volume"/></svg></button><button class="icon-btn remove-row" aria-label="移除 ${word.en}" title="移除"><svg><use href="#i-close"/></svg></button>`;
    actions.querySelector('.speak-row').addEventListener('click', () => speak(word.en));
    actions.querySelector('.remove-row').addEventListener('click', async () => {
      if (state.listType === 'wordbook') state.wordbook = state.wordbook.filter(item => item.en !== word.en);
      else state.mistakes = state.mistakes.filter(item => item.en !== word.en);
      await Store.saveCollection(state.listType, state[state.listType]);
      renderWordList();
      if (currentWord()?.en === word.en) $('#bookmarkBtn').classList.toggle('active', state.wordbook.some(item => item.en === word.en));
      showToast('已移除');
    });
    row.append(main, meta, actions);
    fragment.appendChild(row);
  });
  $('#wordList').replaceChildren(fragment);
}

async function studyCollection() {
  const type = state.listType;
  const words = state[type];
  if (!words.length) return;
  switchView('study');
  await loadStudy(state.chapter, { fresh: true, customWords: [...words], type });
  showToast(type === 'wordbook' ? `开始复习 ${words.length} 个生词` : `开始复习 ${words.length} 个易错词`);
}

function startSpelling() {
  if (!state.words.length || state.sessionType !== 'chapter' || state.studyChapter !== state.chapter) return;
  state.spelling = { queue: state.shuffle ? shuffled(state.words) : [...state.words], index: 0, correct: 0, total: 0, answered: false };
  renderSpelling();
}

function renderSpelling() {
  const spelling = state.spelling;
  const word = spelling.queue[spelling.index];
  if (!word) {
    $('#spellingCount').textContent = '练习完成';
    $('#spellingHint').textContent = `本次完成 ${spelling.total} 词，答对 ${spelling.correct} 词。`;
    $('#spellingInput').value = '';
    $('#spellingInput').disabled = true;
    $('#spellingSubmit').disabled = true;
    $('#spellingSkipBtn').disabled = true;
    $('#spellingFeedback').className = 'spelling-feedback good';
    $('#spellingFeedback').textContent = '点右上角“换一组”，再练一轮。';
    return;
  }
  spelling.answered = false;
  $('#spellingCount').textContent = `${String(spelling.index + 1).padStart(2, '0')} / ${spelling.queue.length}`;
  $('#spellingScore').textContent = `${spelling.correct} 个正确`;
  $('#spellingHint').textContent = word.zh;
  $('#spellingInput').disabled = false;
  $('#spellingInput').value = '';
  $('#spellingInput').className = 'spelling-input';
  $('#spellingSubmit').disabled = false;
  $('#spellingSubmit').innerHTML = '确认拼写<svg><use href="#i-arrow"/></svg>';
  $('#spellingSkipBtn').disabled = false;
  $('#spellingFeedback').textContent = '';
  $('#spellingFeedback').className = 'spelling-feedback';
  $('#spellingAccuracy').textContent = spelling.total ? `${Math.round(spelling.correct / spelling.total * 100)}%` : '—';
}

function revealSpelling(skipped = false) {
  const spelling = state.spelling;
  if (spelling.answered) { spelling.index++; renderSpelling(); $('#spellingInput').focus(); return; }
  const word = spelling.queue[spelling.index];
  if (!word) return;
  const value = $('#spellingInput').value.trim().toLowerCase();
  if (!value && !skipped) { showToast('先写出你记得的拼写'); $('#spellingInput').focus(); return; }
  const correct = !skipped && value === word.en.toLowerCase();
  spelling.answered = true;
  spelling.total++;
  if (correct) spelling.correct++;
  $('#spellingInput').classList.add(correct ? 'correct' : 'wrong');
  $('#spellingFeedback').className = `spelling-feedback ${correct ? 'good' : 'bad'}`;
  $('#spellingFeedback').innerHTML = correct ? '拼写正确，这个词是你的了。' : `${skipped ? '正确答案' : '再记一次'}：<strong></strong>`;
  if (!correct) $('#spellingFeedback strong').textContent = word.en;
  $('#spellingScore').textContent = `${spelling.correct} 个正确`;
  $('#spellingAccuracy').textContent = `${Math.round(spelling.correct / spelling.total * 100)}%`;
  $('#spellingSubmit').innerHTML = '下一个<svg><use href="#i-arrow"/></svg>';
  const stats = state.stats[word.en] ||= { mastery: 0, correctCount: 0, wrongCount: 0 };
  stats.mastery = correct ? Math.min(3, masteryOf(word) + 1) : Math.max(0, masteryOf(word) - 1);
  stats[correct ? 'correctCount' : 'wrongCount'] = (stats[correct ? 'correctCount' : 'wrongCount'] || 0) + 1;
  if (!correct) addMistake(word, false);
  Store.updateSchedule(word.en, correct);
  pruneQueueByMastery();
  renderProgress();
  saveProgress();
}

function openSearch(query = '') {
  if (!$('#searchDialog').open) $('#searchDialog').showModal();
  $('#dialogSearchInput').value = query;
  runSearch(query);
  setTimeout(() => $('#dialogSearchInput').focus(), 50);
}

async function runSearch(query) {
  clearTimeout(searchTimer);
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    $('#searchResults').innerHTML = '<div class="empty-state compact"><svg><use href="#i-book"/></svg><p>在 1,964 个考研词汇中查找</p></div>';
    return;
  }
  $('#searchResults').innerHTML = '<div class="empty-state compact"><p>正在查找…</p></div>';
  const chapters = state.meta.map(meta => meta.ch);
  const allWords = (await Promise.all(chapters.map(async chapter => (await getChapter(chapter)).map(word => ({ ...word, chapter }))))).flat();
  searchTimer = setTimeout(() => {
    const results = allWords.filter(word => word.en.toLowerCase().includes(normalized) || word.zh.toLowerCase().includes(normalized)).slice(0, 80);
    if (!results.length) {
      $('#searchResults').innerHTML = '<div class="empty-state compact"><p>没有找到匹配的单词，换个关键词试试。</p></div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    results.forEach(word => {
      const button = document.createElement('button');
      button.className = 'search-result';
      const content = document.createElement('div');
      const en = document.createElement('strong'); en.textContent = word.en;
      const zh = document.createElement('p'); zh.textContent = word.zh;
      content.append(en, zh);
      const chapter = document.createElement('span'); chapter.textContent = `CH.${String(word.chapter).padStart(2, '0')}`;
      const bookmark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      bookmark.innerHTML = '<use href="#i-chevron"/>';
      button.append(content, chapter, bookmark);
      button.addEventListener('click', () => {
        $('#searchDialog').close();
        switchView('study');
        loadStudy(word.chapter, { fresh: true, customWords: [word], type: 'search' });
      });
      fragment.appendChild(button);
    });
    $('#searchResults').replaceChildren(fragment);
  }, 100);
}

async function exportData() {
  try {
    const raw = await Store.export();
    const data = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wordly-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('学习备份已导出');
  } catch (error) { console.error(error); showToast('导出失败，请稍后再试'); }
}

async function importData(file) {
  try {
    let data = JSON.parse(await file.text());
    if (typeof data === 'string') data = JSON.parse(data);
    const result = await Store.import(data);
    if (!result.success) throw new Error(result.message || '备份内容无效');
    [state.wordbook, state.mistakes, state.schedule] = await Promise.all([Store.loadCollection('wordbook'), Store.loadCollection('mistakes'), Store.loadSchedule()]);
    renderCollectionCounts();
    await loadStudy(state.chapter, { fresh: false });
    $('#settingsDialog').close();
    showToast('学习备份已恢复');
  } catch (error) { console.error(error); showToast(`导入失败：${error.message || '文件格式不正确'}`); }
  $('#importFile').value = '';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn use').setAttribute('href', theme === 'dark' ? '#i-moon' : '#i-sun');
  $('#themeBtn').setAttribute('aria-label', theme === 'dark' ? '切换浅色模式' : '切换深色模式');
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#18201c' : '#f5f7f3';
  localStorage.setItem(`${STORAGE_PREFIX}theme_v2`, theme);
}
function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebarBackdrop').classList.add('show'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebarBackdrop').classList.remove('show'); }

function setSidebarCollapsed(collapsed) {
  const desktop = window.innerWidth > 640;
  document.querySelector('.app-shell').classList.toggle('sidebar-collapsed', collapsed && desktop);
  $('#sidebar').classList.toggle('collapsed', collapsed && desktop);
  $('#expandSidebarBtn').classList.toggle('show', collapsed && desktop);
  localStorage.setItem(`${STORAGE_PREFIX}sidebarCollapsed`, String(collapsed));
}

function bindEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#chapterList').addEventListener('click', event => { const button = event.target.closest('[data-chapter]'); if (button) selectChapter(Number(button.dataset.chapter)); });
  $$('.mode-switch button').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    localStorage.setItem(`${STORAGE_PREFIX}mode`, state.mode);
    $$('.mode-switch button').forEach(item => item.classList.toggle('active', item === button));
    renderCard();
  }));
  $('#flashcard').addEventListener('click', flipCard);
  $('#flashcard').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); flipCard(); } });
  $('#bookmarkBtn').addEventListener('click', event => { event.stopPropagation(); toggleBookmark(); });
  $('#speakBtn').addEventListener('click', event => { event.stopPropagation(); const word = currentWord(); if (word) speak(word.en); });
  $('#knownBtn').addEventListener('click', () => rateWord(true));
  $('#unknownBtn').addEventListener('click', () => rateWord(false));
  $('#resetBtn').addEventListener('click', () => $('#confirmDialog').showModal());
  $('#cancelResetBtn').addEventListener('click', () => $('#confirmDialog').close());
  $('#confirmResetBtn').addEventListener('click', async () => { $('#confirmDialog').close(); await loadStudy(state.chapter, { fresh: true }); showToast('本章已重新开始'); });
  $('#restartBtn').addEventListener('click', () => loadStudy(state.chapter, { fresh: true, customWords: state.sessionType === 'chapter' ? null : state.words, type: state.sessionType }));
  $('#nextChapterBtn').addEventListener('click', () => loadStudy(state.chapter === state.meta.length ? 1 : state.chapter + 1));
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#menuBtn').addEventListener('click', openSidebar);
  $('#collapseSidebarBtn').addEventListener('click', () => setSidebarCollapsed(true));
  $('#expandSidebarBtn').addEventListener('click', () => setSidebarCollapsed(false));
  $('#sidebarBackdrop').addEventListener('click', closeSidebar);
  $('#searchInput').addEventListener('focus', () => { $('#searchInput').blur(); openSearch(); });
  $('#searchInput').addEventListener('click', () => openSearch());
  $('#dialogSearchInput').addEventListener('input', event => runSearch(event.target.value).catch(error => { console.error(error); showToast('搜索失败，请重试'); }));
  $$('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  $$('.app-dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog || dialog.id === 'confirmDialog') return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }));
  $('#settingsBtn').addEventListener('click', () => { closeSidebar(); $('#settingsDialog').showModal(); });
  $('#shuffleToggle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    localStorage.setItem(`${STORAGE_PREFIX}shuffle`, state.shuffle);
    $('#shuffleToggle').setAttribute('aria-checked', String(state.shuffle));
    showToast(state.shuffle ? '新学习队列将随机排列' : '新学习队列将按词库顺序排列');
  });
  $('#testSoundBtn').addEventListener('click', () => speak(currentWord()?.en || 'ambition'));
  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', event => { if (event.target.files[0]) importData(event.target.files[0]); });
  $$('.list-tabs button').forEach(button => button.addEventListener('click', () => { state.listType = button.dataset.list; $('#listSearchInput').value = ''; renderWordList(); }));
  $('#listSearchInput').addEventListener('input', renderWordList);
  $('#studyWordbookBtn').addEventListener('click', studyCollection);
  $('#restartSpellingBtn').addEventListener('click', startSpelling);
  $('#spellingForm').addEventListener('submit', event => { event.preventDefault(); revealSpelling(); });
  $('#spellingSkipBtn').addEventListener('click', () => revealSpelling(true));
  document.addEventListener('keydown', event => {
    const activeTag = document.activeElement?.tagName;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) || document.activeElement?.isContentEditable;
    const insideCard = !!event.target?.closest?.('#flashcard');
    if (event.key === '/' && !$('dialog[open]') && !typing) { event.preventDefault(); openSearch(); return; }
    if ($('dialog[open]') || typing) return;
    if (event.key === 'Escape') { closeSidebar(); return; }
    if (state.view !== 'study' || (!insideCard && activeTag === 'BUTTON')) return;
    if (event.code === 'Space' || event.key === 'ArrowDown') { event.preventDefault(); flipCard(); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); rateWord(true); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); rateWord(false); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
}

async function init() {
  const theme = localStorage.getItem(`${STORAGE_PREFIX}theme_v2`);
  applyTheme(theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  state.mode = localStorage.getItem(`${STORAGE_PREFIX}mode`) || 'en2zh';
  $$('.mode-switch button').forEach(button => button.classList.toggle('active', button.dataset.mode === state.mode));
  $('#shuffleToggle').setAttribute('aria-checked', String(state.shuffle));
  if (localStorage.getItem(`${STORAGE_PREFIX}sidebarCollapsed`) === 'true') setSidebarCollapsed(true);
  bindEvents();
  try {
    const embedded = window.WORD_MEMORY_DATA;
    if (embedded?.meta) {
      state.meta = embedded.meta;
    } else {
      const response = await fetch('./data/meta.json');
      if (!response.ok) throw new Error('词库目录加载失败');
      const metadata = await response.json();
      state.meta = metadata.chapters;
    }
    $('#chapterTotalLabel').textContent = `${state.meta.length} 章`;
    renderChapterList();
    [state.wordbook, state.mistakes, state.schedule] = await Promise.all([Store.loadCollection('wordbook'), Store.loadCollection('mistakes'), Store.loadSchedule()]);
    state.wordbook = Array.isArray(state.wordbook) ? state.wordbook : [];
    state.mistakes = Array.isArray(state.mistakes) ? state.mistakes : [];
    state.schedule = state.schedule && typeof state.schedule === 'object' ? state.schedule : {};
    renderCollectionCounts();
    const progressPromises = state.meta.map(async ({ ch }) => {
      const saved = await Store.loadChapter(ch);
      chapterCache.set(`stats_${ch}`, saved?.wordStats || {});
    });
    await loadStudy(1);
    await Promise.all(progressPromises);
    renderChapterList();
    const canUseServiceWorker = 'serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:');
    if (canUseServiceWorker) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch (error) {
    console.error(error);
    $('#promptText').textContent = '词库未加载';
    $('#cardKicker').textContent = 'PLEASE START A LOCAL SERVER';
    showToast('词库加载失败，请确认 data.js 与 index.html 在同一目录');
  }
}

init();
