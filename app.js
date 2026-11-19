'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const STORAGE_PREFIX = 'wordMemory_';
const MASTERED = 3;
const QUEUE_VERSION = 3; // 3 = 整章纵向单词流（双卡）
const REVIEW_INTERVALS = [20, 60, 540, 1440, 2880, 8640, 44640].map(n => n * 60 * 1000);

const chapterCache = new Map();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  meta: [],
  chapter: 1,
  studyChapter: 1,
  words: [],
  rows: [],
  rowIndex: new Map(),
  stats: {},
  current: 0,
  session: { correct: 0, total: 0 },
  vocabulary: [],
  schedule: {},
  mode: 'en2zh',
  sessionType: 'chapter',
  view: 'study',
  spelling: { queue: [], index: 0, correct: 0, total: 0, answered: false },
  shuffle: localStorage.getItem(`${STORAGE_PREFIX}shuffle`) === 'true',
  busy: false,
  programmaticUntil: 0
};

let toastTimer;
let searchTimer;
let audioTimer;
let scrollTimer;

/* ---------- 本地存储 ---------- */

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${key}`)) ?? fallback; }
  catch { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value)); }
  catch { showToast('浏览器存储空间不足，请先导出备份'); }
}

const Store = {
  loadChapter(chapter) {
    return readLocal(`progress_${chapter}`, {});
  },
  saveChapter(chapter, progress) {
    writeLocal(`progress_${chapter}`, progress);
  },
  loadVocabulary() {
    return readLocal('wordbook', []);
  },
  saveVocabulary(words) {
    writeLocal('wordbook', words);
  },
  loadSchedule() {
    return readLocal('ebbinghaus', {});
  },
  updateSchedule(word, correct) {
    const now = Date.now();
    const record = state.schedule[word] || { stage: 0, lastReview: now };
    record.stage = correct ? Math.min((record.stage || 0) + 1, REVIEW_INTERVALS.length - 1) : 0;
    record.lastReview = now;
    record.nextReview = now + REVIEW_INTERVALS[record.stage];
    state.schedule[word] = record;
    writeLocal('ebbinghaus', state.schedule);
  },
  export() {
    const progress = {};
    state.meta.forEach(({ ch }) => { progress[ch] = readLocal(`progress_${ch}`, {}); });
    return {
      version: '3.0',
      exportDate: Date.now(),
      vocabulary: state.vocabulary,
      wordbook: state.vocabulary,
      mistakes: [],
      progress,
      ebbinghaus: state.schedule
    };
  },
  import(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份内容无效');
    ['vocabulary', 'wordbook', 'mistakes'].forEach(key => {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error('生词本数据格式无效');
    });
    ['progress', 'ebbinghaus'].forEach(key => {
      const value = data[key];
      if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new Error(`${key} 数据格式无效`);
    });

    const merged = [];
    [data.vocabulary, data.wordbook, data.mistakes].forEach(list => (list || []).forEach(item => {
      if (!item || typeof item.en !== 'string') return;
      const existing = merged.find(row => row.en === item.en);
      if (existing) {
        existing.count = Math.max(existing.count || 0, Number(item.count) || 0);
        existing.lastWrongAt = Math.max(existing.lastWrongAt || 0, Number(item.lastWrongAt) || 0);
        existing.zh = existing.zh || item.zh || '';
      } else {
        merged.push({
          en: item.en,
          zh: item.zh || '',
          count: Number(item.count) || 0,
          addedAt: Number(item.addedAt) || Date.now(),
          lastWrongAt: Number(item.lastWrongAt) || 0
        });
      }
    }));
    writeLocal('wordbook', merged);
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

/* ---------- 词库 ---------- */

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

function masteryOf(en) {
  const value = Number(state.stats[en]?.mastery);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MASTERED, value));
}

/* ---------- 行数据 ---------- */

function buildRows(words, saved = null) {
  const byEn = new Map(words.map(word => [word.en, word]));
  const activeEns = [];

  if (saved) {
    saved.order.forEach(en => { if (byEn.has(en)) activeEns.push(en); });
  } else {
    const pending = words.filter(word => masteryOf(word.en) < MASTERED).map(word => word.en);
    activeEns.push(...(state.shuffle ? shuffled(pending) : pending));
  }

  const rows = activeEns.map(en => {
    const word = byEn.get(en);
    const answered = saved?.answered?.[en] || null;
    return { en, zh: word.zh, answered, revealed: Boolean(answered), locked: false };
  });

  // 已经掌握的词也列出来，灰化排在整章末尾
  words.forEach(word => {
    if (masteryOf(word.en) >= MASTERED && !activeEns.includes(word.en)) {
      rows.push({ en: word.en, zh: word.zh, answered: null, revealed: true, locked: true });
    }
  });
  return rows;
}

function buildCustomRows(words) {
  return words.map(word => ({ en: word.en, zh: word.zh, answered: null, revealed: false, locked: false }));
}

function validProgress(saved, words) {
  if (!saved || saved.queueVersion !== QUEUE_VERSION) return false;
  if (!Array.isArray(saved.order) || !saved.order.length) return false;
  if (!saved.answered || typeof saved.answered !== 'object' || Array.isArray(saved.answered)) return false;
  if (!Number.isInteger(saved.current)) return false;
  const known = new Set(words.map(word => word.en));
  return saved.order.every(en => known.has(en));
}

function saveProgress() {
  if (state.sessionType !== 'chapter') return;
  const active = state.rows.filter(row => !row.locked);
  const answered = active.reduce((acc, row) => { if (row.answered) acc[row.en] = row.answered; return acc; }, {});
  const progress = {
    queueVersion: QUEUE_VERSION,
    order: active.map(row => row.en),
    answered,
    current: state.current,
    wordStats: state.stats,
    sessionStats: state.session,
    sessionType: state.sessionType
  };
  Store.saveChapter(state.chapter, progress);
}

/* ---------- 加载 ---------- */

function clampIndex(index) {
  if (!state.rows.length) return 0;
  return Math.max(0, Math.min(state.rows.length - 1, index));
}

function firstUnansweredIndex() {
  const index = state.rows.findIndex(row => !row.locked && !row.answered);
  return index === -1 ? 0 : index;
}

async function loadStudy(chapter = state.chapter, { fresh = false, customWords = null, type = 'chapter', focusWord = null } = {}) {
  state.chapter = chapter;
  state.busy = false;
  try {
    const words = await getChapter(chapter);
    state.sessionType = type;
    state.studyChapter = chapter;
    state.words = customWords || words;

    if (type === 'chapter') {
      const saved = Store.loadChapter(chapter);
      state.stats = saved?.wordStats && typeof saved.wordStats === 'object' && !Array.isArray(saved.wordStats) ? saved.wordStats : {};
      state.words.forEach(word => { state.stats[word.en] ||= { mastery: 0, correctCount: 0, wrongCount: 0 }; });
      const resumable = !fresh && validProgress(saved, state.words);
      state.rows = buildRows(state.words, resumable ? saved : null);
      if (resumable) {
        const sessionStats = saved.sessionStats || {};
        state.session = { correct: Number(sessionStats.correct) || 0, total: Number(sessionStats.total) || 0 };
        state.current = clampIndex(saved.current);
        if (state.rows[state.current]?.answered) state.current = firstUnansweredIndex();
      } else {
        state.session = { correct: 0, total: 0 };
        state.current = firstUnansweredIndex();
      }
      chapterCache.set(`stats_${chapter}`, state.stats);
    } else {
      state.stats = {};
      state.rows = buildCustomRows(state.words);
      state.session = { correct: 0, total: 0 };
      state.current = 0;
    }

    renderStack();
    renderChapterList();
    renderProgress();
    if (type === 'chapter') saveProgress();
    if (focusWord) focusOn(focusWord);
    else scrollToRow(state.current, false);
  } catch (error) {
    console.error(error);
    showToast(error.message || '词库加载失败，请确认 data.js 与 index.html 在同一目录');
  }
}

/* ---------- 渲染 ---------- */

function statusTextFor(row) {
  if (row.locked) return '已掌握';
  if (row.answered === 'known') return '已记住';
  if (row.answered === 'unknown') return '标记不熟';
  return masteryOf(row.en) > 0 ? '继续熟悉' : '新单词';
}

function createRow(row, index) {
  const article = document.createElement('article');
  article.className = 'word-pair';
  article.dataset.index = String(index);
  article.innerHTML = `
    <div class="pair-head">
      <span class="pair-index">${String(index + 1).padStart(2, '0')}</span>
      <span class="pair-status"></span>
      <span class="pair-badge" hidden></span>
      <button class="card-icon pair-bookmark" type="button" aria-label="收藏到生词本" title="收藏到生词本"><svg><use href="#i-bookmark"/></svg></button>
    </div>
    <div class="pair-body">
      <div class="card word-card">
        <span class="card-kicker"></span>
        <h2 class="word-text"></h2>
        <button class="pronunciation" type="button"><svg><use href="#i-volume"/></svg><span>点击发音</span></button>
        <span class="mastery-dots" aria-label="熟练度"><i></i><i></i><i></i></span>
      </div>
      <div class="card meaning-card">
        <span class="meaning-label">WORD MEANING</span>
        <p class="meaning-text"></p>
        <span class="unblur-hint"><kbd>↓</kbd><span>显示释义</span></span>
      </div>
    </div>`;
  updateRowEl(article, row);
  return article;
}

function updateRowEl(el, row) {
  if (!el) return;
  const englishFirst = state.mode === 'en2zh';
  const isCurrent = state.rows[state.current] === row;
  el.className = [
    'word-pair',
    row.locked ? 'locked' : '',
    row.answered ? `answered-${row.answered}` : '',
    row.revealed ? 'revealed' : '',
    isCurrent ? 'current' : ''
  ].filter(Boolean).join(' ');

  const wordText = el.querySelector('.word-text');
  wordText.textContent = englishFirst ? row.en : row.zh;
  wordText.classList.toggle('chinese', !englishFirst);

  const meaningText = el.querySelector('.meaning-text');
  meaningText.textContent = englishFirst ? row.zh : row.en;
  meaningText.classList.toggle('english', !englishFirst);

  el.querySelector('.card-kicker').textContent = englishFirst ? 'DO YOU KNOW THIS WORD?' : 'WHICH WORD DOES IT MEAN?';
  el.querySelector('.meaning-label').textContent = englishFirst ? 'WORD MEANING' : 'ENGLISH WORD';
  el.querySelector('.pair-status').textContent = statusTextFor(row);

  const badge = el.querySelector('.pair-badge');
  const answered = row.answered && !row.locked ? row.answered : null;
  badge.hidden = !answered;
  badge.className = `pair-badge${answered ? ` ${answered}` : ''}`;
  badge.textContent = answered === 'known' ? '记住' : answered === 'unknown' ? '不熟' : '';

  const bookmark = el.querySelector('.pair-bookmark');
  bookmark.classList.toggle('active', vocabularyHas(row.en));

  el.querySelector('.pronunciation').hidden = !englishFirst;

  [...el.querySelectorAll('.mastery-dots i')].forEach((dot, i) => dot.classList.toggle('filled', i < masteryOf(row.en)));

  const meaningCard = el.querySelector('.meaning-card');
  meaningCard.classList.toggle('blurred', !row.revealed && !row.locked);
}

function renderStack() {
  const inner = $('#wordStackInner');
  const fragment = document.createDocumentFragment();
  state.rows.forEach((row, index) => fragment.appendChild(createRow(row, index)));
  inner.replaceChildren(fragment);

  state.rowIndex.clear();
  state.rows.forEach((row, index) => state.rowIndex.set(row.en, index));

  $('#chapterTag').textContent = `CHAPTER ${String(state.studyChapter).padStart(2, '0')}`;
  $('#spellingSubtitle').textContent = state.sessionType === 'wordbook'
    ? '生词本 · 根据释义拼写英文单词'
    : `Chapter ${String(state.studyChapter).padStart(2, '0')} · 根据中文释义拼写英文单词`;
  $('#chapterTotal').textContent = state.words.length;
  $('#sessionKind').textContent = state.sessionType === 'wordbook' ? '生词复习' : state.shuffle ? '随机学习' : '顺序学习';
  $('#breadcrumbCurrent').textContent = '词汇记忆';

  renderFinished();
  updateSessionUi();
  syncPairHeight();
}

function updateSessionUi() {
  const active = state.rows.filter(row => !row.locked);
  const answered = active.filter(row => row.answered).length;
  $('#sessionCount').textContent = `${answered} / ${active.length}`;
  $('#sessionProgress').style.width = `${active.length ? answered / active.length * 100 : 0}%`;
}

function renderFinished() {
  const remaining = state.rows.filter(row => !row.locked && !row.answered).length;
  const finished = $('#finishedCard');
  const done = remaining === 0;
  finished.hidden = !done;
  $('#recallActions').hidden = done;
  $('.keyboard-hint').hidden = done;
  if (done) {
    const accuracy = state.session.total ? Math.round(state.session.correct / state.session.total * 100) : 0;
    $('#finishedSummary').textContent = state.session.total
      ? `完成 ${state.session.total} 次回忆，认识率 ${accuracy}%。不熟的词，下一轮再见。`
      : '这一章已经全部掌握，可以直接进入下一章。';
  }
}

function renderProgress() {
  const mastered = state.words.filter(word => masteryOf(word.en) >= MASTERED).length;
  const learning = state.words.filter(word => { const level = masteryOf(word.en); return level > 0 && level < MASTERED; }).length;
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
    button.setAttribute('aria-label', `第 ${ch} 章${ch === state.studyChapter ? '，当前章节' : ''}`);
    fragment.appendChild(button);
  });
  $('#chapterList').replaceChildren(fragment);
}

/* ---------- 滚动与当前卡片 ---------- */

function rowElAt(index) {
  return $('#wordStackInner')?.children[index] || null;
}

function syncPairHeight() {
  const stack = $('#wordStack');
  if (!stack) return;
  // 留一点下一张的边，滑动时能看出这是一叠卡片
  stack.style.setProperty('--pair-height', `${Math.max(220, stack.clientHeight - 40)}px`);
}

function scrollToRow(index, smooth = true) {
  const stack = $('#wordStack');
  const el = rowElAt(index);
  if (!stack || !el) return;
  const target = el.offsetTop - Math.max(0, (stack.clientHeight - el.offsetHeight) / 2);
  state.programmaticUntil = Date.now() + (smooth ? 420 : 60);
  stack.scrollTo({ top: Math.max(0, target), behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto' });
}

function setCurrent(index, { scroll = false } = {}) {
  if (!state.rows.length) return;
  const next = clampIndex(index);
  const prevEl = rowElAt(state.current);
  state.current = next;
  prevEl?.classList.remove('current');
  rowElAt(next)?.classList.add('current');
  updateSessionUi();
  if (scroll) scrollToRow(next, true);
}

function syncCurrentFromScroll() {
  if (state.view !== 'study' || !state.rows.length) return;
  const stack = $('#wordStack');
  if (!stack) return;
  const center = stack.scrollTop + stack.clientHeight / 2;
  let best = state.current;
  let bestDistance = Infinity;
  [...$('#wordStackInner').children].forEach((el, index) => {
    const middle = el.offsetTop + el.offsetHeight / 2;
    const distance = Math.abs(middle - center);
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  });
  if (best !== state.current) setCurrent(best);
}

function focusOn(en) {
  const index = state.rowIndex.get(en);
  if (index === undefined) { scrollToRow(state.current, false); return; }
  setCurrent(index);
  scrollToRow(index, false);
}

/* ---------- 答题 ---------- */

function revealCurrent() {
  const row = state.rows[state.current];
  if (!row || row.locked || row.revealed) return;
  row.revealed = true;
  const el = rowElAt(state.current);
  if (!el) return;
  el.classList.add('revealed');
  el.querySelector('.meaning-card')?.classList.remove('blurred');
}

function nextUnanswered(from) {
  for (let i = from + 1; i < state.rows.length; i++) {
    const row = state.rows[i];
    if (!row.locked && !row.answered) return i;
  }
  for (let i = 0; i < state.rows.length; i++) {
    const row = state.rows[i];
    if (!row.locked && !row.answered) return i;
  }
  return -1;
}

function advanceToNext() {
  const next = nextUnanswered(state.current);
  if (next >= 0) {
    setCurrent(next, { scroll: true });
    return;
  }
  renderFinished();
  const finished = $('#finishedCard');
  if (!finished.hidden) {
    const stack = $('#wordStack');
    state.programmaticUntil = Date.now() + 420;
    stack.scrollTo({ top: finished.offsetTop - 12, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
}

function markCurrent(correct) {
  const row = state.rows[state.current];
  if (!row || row.locked || state.busy) return;
  if (row.answered) {
    showToast('这个词已经标记过了');
    advanceToNext();
    return;
  }
  state.busy = true;

  const before = masteryOf(row.en);
  const stats = state.stats[row.en] ||= { mastery: 0, correctCount: 0, wrongCount: 0 };
  stats.mastery = correct ? Math.min(MASTERED, before + 1) : Math.max(0, before - 1);
  const countKey = correct ? 'correctCount' : 'wrongCount';
  stats[countKey] = (stats[countKey] || 0) + 1;

  row.answered = correct ? 'known' : 'unknown';
  row.revealed = true; // 标记后答案常显，回看时不用再按一次
  state.session.total += 1;
  if (correct) state.session.correct += 1;
  if (!correct) addToVocabulary(row);
  Store.updateSchedule(row.en, correct);

  updateRowEl(rowElAt(state.current), row);
  renderProgress();
  updateSessionUi();
  saveProgress();

  state.busy = false;
  advanceToNext();
}

/* ---------- 生词本（收藏 + 不熟 合并） ---------- */

function vocabularyHas(en) {
  return state.vocabulary.some(item => item.en === en);
}

function refreshBookmark(en) {
  const index = state.rowIndex.get(en);
  if (index === undefined) return;
  rowElAt(index)?.querySelector('.pair-bookmark')?.classList.toggle('active', vocabularyHas(en));
}

function addToVocabulary(word) {
  const existing = state.vocabulary.find(item => item.en === word.en);
  if (existing) {
    existing.count = (existing.count || 0) + 1;
    existing.lastWrongAt = Date.now();
    existing.zh = word.zh || existing.zh;
  } else {
    state.vocabulary.push({ en: word.en, zh: word.zh, count: 1, addedAt: Date.now(), lastWrongAt: Date.now() });
  }
  Store.saveVocabulary(state.vocabulary);
  renderCollectionCounts();
  refreshBookmark(word.en);
}

function toggleBookmark(index) {
  const row = state.rows[index];
  if (!row) return;
  if (vocabularyHas(row.en)) {
    state.vocabulary = state.vocabulary.filter(item => item.en !== row.en);
    Store.saveVocabulary(state.vocabulary);
    renderCollectionCounts();
    refreshBookmark(row.en);
    showToast('已从生词本移除');
    return;
  }
  state.vocabulary.push({ en: row.en, zh: row.zh, count: 0, addedAt: Date.now() });
  Store.saveVocabulary(state.vocabulary);
  renderCollectionCounts();
  refreshBookmark(row.en);
  showToast('已收藏到生词本');
}

function renderCollectionCounts() {
  $('#wordbookCount').textContent = state.vocabulary.length;
  $('#listTotalCount').textContent = state.vocabulary.length;
}

function renderWordList() {
  renderCollectionCounts();
  const query = $('#listSearchInput').value.trim().toLowerCase();
  const source = state.vocabulary;
  const words = source.filter(word => word.en.toLowerCase().includes(query) || (word.zh || '').toLowerCase().includes(query));

  $('#wordbookSubtitle').textContent = source.length
    ? `共 ${source.length} 个词，收藏和标记不熟的都留在这份名单里。`
    : '收藏和标记不熟的词，都会自动留在这里。';
  $('#studyWordbookBtn').disabled = source.length === 0;

  if (!words.length) {
    $('#wordList').innerHTML = `<div class="empty-state"><svg><use href="#i-bookmark"/></svg><h3>${query ? '没有找到匹配的单词' : '生词本还是空的'}</h3><p>${query ? '换一个关键词试试。' : '背词时点右上角的书签收藏，或者标记“还不认识”，词就会自动进来。'}</p>${query ? '' : '<button class="secondary-btn" id="emptyStudyBtn">去背一组单词<svg><use href="#i-arrow"/></svg></button>'}</div>`;
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
    meta.textContent = (word.count || 0) > 1 ? `×${word.count}` : '';

    const actions = document.createElement('div');
    actions.className = 'word-row-actions';
    actions.innerHTML = `<button class="icon-btn speak-row" aria-label="朗读 ${word.en}" title="朗读"><svg><use href="#i-volume"/></svg></button><button class="icon-btn remove-row" aria-label="移除 ${word.en}" title="移除"><svg><use href="#i-close"/></svg></button>`;
    actions.querySelector('.speak-row').addEventListener('click', () => speak(word.en, actions.querySelector('.speak-row')));
    actions.querySelector('.remove-row').addEventListener('click', () => {
      state.vocabulary = state.vocabulary.filter(item => item.en !== word.en);
      Store.saveVocabulary(state.vocabulary);
      renderWordList();
      refreshBookmark(word.en);
      showToast('已移除');
    });

    row.append(main, meta, actions);
    fragment.appendChild(row);
  });
  $('#wordList').replaceChildren(fragment);
}

function studyCollection() {
  if (!state.vocabulary.length) return;
  switchView('study');
  loadStudy(state.chapter, { fresh: true, customWords: [...state.vocabulary], type: 'wordbook' });
  showToast(`开始复习 ${state.vocabulary.length} 个生词`);
}

/* ---------- 拼写 ---------- */

function startSpelling() {
  if (!state.words.length) { showToast('这一章还没有可练习的词'); return; }
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
  const before = masteryOf(word.en);
  stats.mastery = correct ? Math.min(MASTERED, before + 1) : Math.max(0, before - 1);
  const countKey = correct ? 'correctCount' : 'wrongCount';
  stats[countKey] = (stats[countKey] || 0) + 1;

  if (!correct) addToVocabulary(word);
  Store.updateSchedule(word.en, correct);
  const index = state.rowIndex.get(word.en);
  if (index !== undefined) updateRowEl(rowElAt(index), state.rows[index]);
  renderProgress();
  updateSessionUi();
  saveProgress();
}

/* ---------- 搜索 ---------- */

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
        loadStudy(word.chapter, { focusWord: word.en });
      });
      fragment.appendChild(button);
    });
    $('#searchResults').replaceChildren(fragment);
  }, 100);
}

/* ---------- 备份 ---------- */

function exportData() {
  try {
    const data = JSON.stringify(Store.export(), null, 2);
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
    const result = Store.import(data);
    if (!result.success) throw new Error(result.message || '备份内容无效');
    const stored = Store.loadVocabulary();
    state.vocabulary = Array.isArray(stored) ? stored : [];
    const schedule = Store.loadSchedule();
    state.schedule = schedule && typeof schedule === 'object' ? schedule : {};
    renderCollectionCounts();
    await loadStudy(state.chapter, { fresh: false });
    $('#settingsDialog').close();
    showToast('学习备份已恢复');
  } catch (error) { console.error(error); showToast(`导入失败：${error.message || '文件格式不正确'}`); }
  $('#importFile').value = '';
}

/* ---------- 杂项 ---------- */

function speak(text, button = null) {
  if (!('speechSynthesis' in window)) { showToast('当前环境不支持语音朗读'); return; }
  speechSynthesis.cancel();
  clearTimeout(audioTimer);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = .9;
  button?.classList.add('speaking');
  const stop = () => button?.classList.remove('speaking');
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

/* ---------- 旧数据迁移 ---------- */

function migrateVocabulary() {
  const legacy = readLocal('mistakes', null);
  if (!Array.isArray(legacy) || !legacy.length) return;
  const current = readLocal('wordbook', []);
  const merged = Array.isArray(current) ? current.map(item => ({ ...item })) : [];
  legacy.forEach(item => {
    if (!item || typeof item.en !== 'string') return;
    const existing = merged.find(row => row.en === item.en);
    if (existing) {
      existing.count = Math.max(existing.count || 0, Number(item.count) || 1);
      existing.lastWrongAt = Math.max(existing.lastWrongAt || 0, Number(item.lastWrongAt) || 0);
      existing.zh = existing.zh || item.zh || '';
    } else {
      merged.push({
        en: item.en,
        zh: item.zh || '',
        count: Number(item.count) || 1,
        addedAt: Number(item.lastWrongAt) || Date.now(),
        lastWrongAt: Number(item.lastWrongAt) || 0
      });
    }
  });
  writeLocal('wordbook', merged);
  writeLocal('mistakes_legacy_v2', legacy);
  try { localStorage.removeItem(`${STORAGE_PREFIX}mistakes`); } catch {}
}

/* ---------- 事件 ---------- */

function bindEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#chapterList').addEventListener('click', event => {
    const button = event.target.closest('[data-chapter]');
    if (button) { closeSidebar(); switchView('study'); loadStudy(Number(button.dataset.chapter)); }
  });

  $$('.mode-switch button').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    localStorage.setItem(`${STORAGE_PREFIX}mode`, state.mode);
    $$('.mode-switch button').forEach(item => item.classList.toggle('active', item === button));
    if (state.rows.length) { renderStack(); scrollToRow(state.current, false); }
  }));

  $('#wordStack').addEventListener('scroll', () => {
    if (Date.now() < state.programmaticUntil) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(syncCurrentFromScroll, 110);
  }, { passive: true });

  $('#wordStackInner').addEventListener('click', event => {
    const rowEl = event.target.closest('.word-pair');
    if (!rowEl) return;
    const index = Number(rowEl.dataset.index);
    if (event.target.closest('.pair-bookmark')) { toggleBookmark(index); return; }
    const pronunciation = event.target.closest('.pronunciation');
    if (pronunciation) { speak(state.rows[index].en, pronunciation); return; }
    setCurrent(index);
    if (event.target.closest('.meaning-card')) revealCurrent();
  });

  $('#knownBtn').addEventListener('click', () => markCurrent(true));
  $('#unknownBtn').addEventListener('click', () => markCurrent(false));

  $('#resetBtn').addEventListener('click', () => $('#confirmDialog').showModal());
  $('#cancelResetBtn').addEventListener('click', () => $('#confirmDialog').close());
  $('#confirmResetBtn').addEventListener('click', () => {
    $('#confirmDialog').close();
    loadStudy(state.chapter, { fresh: true });
    showToast('本章已重新开始');
  });
  $('#restartBtn').addEventListener('click', () => {
    const custom = state.sessionType === 'wordbook' ? [...state.words] : null;
    loadStudy(state.chapter, { fresh: true, customWords: custom, type: state.sessionType });
  });
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
    $('#sessionKind').textContent = state.sessionType === 'wordbook' ? '生词复习' : state.shuffle ? '随机学习' : '顺序学习';
    showToast(state.shuffle ? '新学习队列将随机排列' : '新学习队列将按词库顺序排列');
  });
  $('#testSoundBtn').addEventListener('click', () => speak(state.rows[state.current]?.en || 'ambition'));
  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', event => { if (event.target.files[0]) importData(event.target.files[0]); });

  $('#listSearchInput').addEventListener('input', renderWordList);
  $('#studyWordbookBtn').addEventListener('click', studyCollection);
  $('#restartSpellingBtn').addEventListener('click', startSpelling);
  $('#spellingForm').addEventListener('submit', event => { event.preventDefault(); revealSpelling(); });
  $('#spellingSkipBtn').addEventListener('click', () => revealSpelling(true));

  document.addEventListener('keydown', event => {
    const activeTag = document.activeElement?.tagName;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) || document.activeElement?.isContentEditable;
    if (event.key === '/' && !$('dialog[open]') && !typing) { event.preventDefault(); openSearch(); return; }
    if ($('dialog[open]') || typing) return;
    if (event.key === 'Escape') { closeSidebar(); return; }
    if (state.view !== 'study') return;
    if (activeTag === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return;
    if (event.repeat) return;
    if (event.key === 'ArrowDown' || event.key === ' ') { event.preventDefault(); revealCurrent(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setCurrent(state.current - 1, { scroll: true }); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); markCurrent(true); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); markCurrent(false); }
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
  window.addEventListener('resize', () => {
    if (state.view !== 'study') return;
    syncPairHeight();
    if (state.rows.length) scrollToRow(state.current, false);
  });
  if ('ResizeObserver' in window) {
    const stack = $('#wordStack');
    if (stack) new ResizeObserver(() => { syncPairHeight(); }).observe(stack);
  }
}

/* ---------- 启动 ---------- */

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
      state.meta = (await response.json()).chapters;
    }
    $('#chapterTotalLabel').textContent = `${state.meta.length} 章`;

    migrateVocabulary();
    const storedVocabulary = Store.loadVocabulary();
    state.vocabulary = Array.isArray(storedVocabulary) ? storedVocabulary : [];
    const storedSchedule = Store.loadSchedule();
    state.schedule = storedSchedule && typeof storedSchedule === 'object' ? storedSchedule : {};
    state.meta.forEach(({ ch }) => {
      const saved = Store.loadChapter(ch);
      chapterCache.set(`stats_${ch}`, saved?.wordStats || {});
    });
    renderCollectionCounts();
    renderChapterList();

    await loadStudy(1);
    renderChapterList();

    const canUseServiceWorker = 'serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:');
    if (canUseServiceWorker) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch (error) {
    console.error(error);
    showToast('词库加载失败，请确认 data.js 与 index.html 在同一目录');
  }
}

init();
