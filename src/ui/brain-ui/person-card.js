import { apiUrl } from './api-client.js';

let personCardActive = false;
let currentCard = null;
let imageLookupToken = 0;
let revealTimer = null;
let animationTimer = null;

const PERSON_CARD_REVEAL_DELAY_MS = 1000;
const PERSON_CARD_LEAVE_MS = 220;
const PERSON_CARD_ENTER_MS = 280;

const $ = (id) => document.getElementById(id);

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，、;；\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}

function uniqueList(items = []) {
  return [...new Set(items.map(v => String(v || '').trim()).filter(Boolean))];
}

function cleanLine(value = '') {
  return String(value || '')
    .replace(/^[\s>*\-•·]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKnownForFromText(text = '') {
  const value = cleanLine(text);
  const items = [];
  const patterns = [
    /(?:创办了|创建了|创立了|代表作(?:包括|有)?|作品(?:包括|有)?|known for[:：]?)\s*([^。.!！？；;]+)/gi,
    /(?:创始人|创办人|联合创始人)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(value))) {
      if (!match[1]) {
        const sentenceStart = Math.max(0, value.lastIndexOf('，', match.index) + 1);
        items.push(value.slice(sentenceStart, pattern.lastIndex));
        continue;
      }
      items.push(
        ...match[1]
          .split(/[,，、/和及与]|以及/)
          .map(part => cleanLine(part).replace(/^(?:了|的)\s*/, ''))
          .filter(Boolean),
      );
    }
  }

  return uniqueList(items).slice(0, 6);
}

function formatUpdatedAt(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function initials(name = '') {
  const compact = String(name || '').trim();
  if (!compact) return '人';
  const chars = [...compact.replace(/\s+/g, '')];
  return chars.slice(0, Math.min(2, chars.length)).join('');
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHeroImage(src = '', name = '') {
  const hero = $('pc-hero');
  const heroImg = $('pc-hero-img');
  const fallback = $('pc-hero-fallback');
  const imageUrl = String(src || '').trim();
  if (fallback) fallback.textContent = initials(name);
  if (heroImg) {
    heroImg.src = imageUrl;
    heroImg.alt = imageUrl ? name : '';
    heroImg.hidden = !imageUrl;
  }
  if (hero) hero.classList.toggle('pc-hero-has-image', !!imageUrl);
}

async function findPersonImage(name = '') {
  const query = String(name || '').trim();
  if (!query || query === '人物卡片' || query === '未知人物') return '';
  const endpoints = [
    `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const image = data?.thumbnail?.source || data?.originalimage?.source || '';
      if (image) return image;
    } catch {}
  }
  return '';
}

function scheduleHeroImageLookup(card = {}) {
  const name = String(card.name || '').trim();
  const explicitImage = String(card.image || card.avatar || '').trim();
  const token = ++imageLookupToken;
  setHeroImage(explicitImage, name);
  if (explicitImage) return;
  findPersonImage(name).then((image) => {
    if (token !== imageLookupToken || !image) return;
    if (currentCard?.name !== name) return;
    currentCard = { ...currentCard, image, avatar: currentCard?.avatar || image };
    setHeroImage(image, name);
    reportPersonCardState(personCardActive, 'image_lookup', currentCard);
  });
}

function renderPersonCard(card = {}) {
  currentCard = card;
  const name = String(card.name || '未知人物').trim();
  setText('pc-name', name);
  setText('pc-title', card.title || '人物卡片');
  setText('pc-summary', card.summary || '暂无简介。');
  setText('pc-source', `来源：${card.source || '人物卡片'}`);
  setText('pc-updated', formatUpdatedAt(card.updatedAt));
  scheduleHeroImageLookup(card);

  const voiceInput = $('pc-voice-id');
  if (voiceInput) voiceInput.value = card.preferredVoice || '';
  const langSelect = $('pc-language');
  if (langSelect) langSelect.value = card.preferredLanguage || '';
  const cloneStatus = $('pc-clone-status');
  if (cloneStatus) cloneStatus.textContent = '';

  const knownList = $('pc-known-list');
  if (knownList) {
    const knownFor = normalizeList(card.knownFor);
    knownList.innerHTML = '';
    if (!knownFor.length) {
      const li = document.createElement('li');
      li.textContent = '暂无代表作品或识别点';
      knownList.appendChild(li);
    } else {
      for (const item of knownFor.slice(0, 6)) {
        const li = document.createElement('li');
        li.textContent = item;
        knownList.appendChild(li);
      }
    }
  }

  const tagsEl = $('pc-tags');
  if (tagsEl) {
    tagsEl.innerHTML = '';
    const tags = normalizeList(card.tags);
    for (const tag of tags.slice(0, 8)) {
      const span = document.createElement('span');
      span.className = 'pc-tag';
      span.textContent = tag;
      tagsEl.appendChild(span);
    }
  }
}

function reportPersonCardState(visible, source = 'brain-ui', card = currentCard) {
  fetch(apiUrl('/person-card-state'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!visible, source, card }),
  }).catch(() => {});
}

export function setPersonCardMode(visible, { source = 'brain-ui', card = null } = {}) {
  const nextVisible = !!visible;
  const panel = $('person-card-panel');
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  if (animationTimer) { clearTimeout(animationTimer); animationTimer = null; }

  if (!nextVisible) {
    if (card) renderPersonCard(card);
    personCardActive = false;
    if (panel && panel.classList.contains('pc-visible')) {
      panel.classList.remove('pc-entering');
      panel.classList.add('pc-leaving');
      animationTimer = setTimeout(() => {
        animationTimer = null;
        document.body.classList.remove('person-card-mode');
        panel.classList.remove('pc-visible', 'pc-leaving');
      }, PERSON_CARD_LEAVE_MS);
    } else {
      document.body.classList.remove('person-card-mode');
      if (panel) panel.classList.remove('pc-visible', 'pc-entering', 'pc-leaving');
    }
    reportPersonCardState(false, source, currentCard);
    return;
  }

  // 切换不同人物：先退场，退场结束后立即入场新卡片（跳过初始延迟）
  const isDifferentPerson = card?.name && currentCard?.name && card.name !== currentCard.name;
  if (personCardActive && isDifferentPerson && panel?.classList.contains('pc-visible')) {
    panel.classList.remove('pc-entering');
    panel.classList.add('pc-leaving');
    animationTimer = setTimeout(() => {
      animationTimer = null;
      panel.classList.remove('pc-visible', 'pc-leaving');
      renderPersonCard(card);
      panel.classList.add('pc-visible', 'pc-entering');
      personCardActive = true;
      animationTimer = setTimeout(() => {
        animationTimer = null;
        panel.classList.remove('pc-entering');
      }, PERSON_CARD_ENTER_MS);
      reportPersonCardState(true, source, currentCard);
    }, PERSON_CARD_LEAVE_MS);
    return;
  }

  // 正常打开（面板关闭状态，或同一人物更新数据）
  if (card) renderPersonCard(card);
  revealTimer = setTimeout(() => {
    revealTimer = null;
    personCardActive = true;
    document.body.classList.add('person-card-mode');
    if (panel) {
      panel.classList.remove('pc-leaving');
      panel.classList.add('pc-visible', 'pc-entering');
      animationTimer = setTimeout(() => {
        animationTimer = null;
        panel.classList.remove('pc-entering');
      }, PERSON_CARD_ENTER_MS);
    }
    reportPersonCardState(true, source, currentCard);
  }, PERSON_CARD_REVEAL_DELAY_MS);
}

export function enrichVisiblePersonCardFromText(text, { source = 'assistant_summary' } = {}) {
  if (!personCardActive || !currentCard) return false;
  const summary = cleanLine(text).slice(0, 260);
  if (!summary) return false;

  const knownFor = uniqueList([
    ...normalizeList(currentCard.knownFor),
    ...extractKnownForFromText(summary),
  ]);
  renderPersonCard({
    ...currentCard,
    summary,
    knownFor,
    source: currentCard.source === 'fallback' ? 'assistant' : currentCard.source,
    updatedAt: new Date().toISOString(),
  });
  reportPersonCardState(true, source, currentCard);
  return true;
}

export function togglePersonCard(source = 'brain-ui') {
  setPersonCardMode(!personCardActive, { source });
}

export async function showPersonCardByName(name, { source = 'brain-ui' } = {}) {
  const query = String(name || '').trim();
  if (!query) return;
  try {
    const res = await fetch(apiUrl(`/person-card?name=${encodeURIComponent(query)}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setPersonCardMode(true, { source, card: data.card || { name: query } });
  } catch (err) {
    console.warn('[PersonCard] 人物卡片加载失败:', err.message);
    setPersonCardMode(true, {
      source,
      card: {
        name: query,
        title: '人物卡片',
        summary: '暂时没有资料。可以让 Longma 补充这个人的身份和代表作品。',
        knownFor: [],
        tags: ['待补充'],
        source: 'fallback',
        updatedAt: new Date().toISOString(),
      },
    });
  }
}


export function initPersonCard() {
  renderPersonCard(currentCard || {
    name: '人物卡片',
    title: '待命',
    summary: '当你不认识某位公众人物时，Longma 会在这里弹出一张简短人物卡片。',
    knownFor: [],
    tags: ['standby'],
    source: 'standby',
  });

  const exitBtn = $('pc-exit-btn');
  if (exitBtn) exitBtn.addEventListener('click', () => setPersonCardMode(false, { source: 'brain-ui' }));

  const voiceInput = $('pc-voice-id');
  const cloneBtn = $('pc-clone-voice-btn');
  const cloneFile = $('pc-clone-file');
  const testBtn = $('pc-test-voice-btn');
  const cloneStatus = $('pc-clone-status');

  function showCloneStatus(msg, isError = false) {
    if (!cloneStatus) return;
    cloneStatus.textContent = msg;
    cloneStatus.style.color = isError ? '#e05050' : 'var(--ink2)';
    if (!isError) setTimeout(() => { cloneStatus.textContent = ''; }, 4000);
  }

  async function saveVoiceId(voiceId) {
    if (!currentCard?.name || !voiceId) return;
    try {
      await fetch(apiUrl('/person-card/voice'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: currentCard.name, voiceId }),
      });
      currentCard.preferredVoice = voiceId;
    } catch (err) {
      console.warn('[PersonCard] 保存声音失败:', err.message);
    }
  }

  if (voiceInput) {
    voiceInput.addEventListener('change', () => {
      const vid = voiceInput.value.trim();
      if (vid) saveVoiceId(vid);
    });
  }

  async function saveLanguage(language) {
    if (!currentCard?.name) return;
    try {
      await fetch(apiUrl('/person-card/language'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: currentCard.name, language }),
      });
      currentCard.preferredLanguage = language;
    } catch (err) {
      console.warn('[PersonCard] 保存语言失败:', err.message);
    }
  }

  const langSelect = $('pc-language');
  if (langSelect) {
    langSelect.addEventListener('change', () => {
      saveLanguage(langSelect.value);
    });
  }

  if (cloneBtn && cloneFile) {
    cloneBtn.addEventListener('click', () => cloneFile.click());
    cloneFile.addEventListener('change', async () => {
      const file = cloneFile.files?.[0];
      if (!file) return;
      showCloneStatus('上传中…');
      cloneBtn.disabled = true;
      try {
        const formData = new FormData();
        // Generate a default name from the voice input label or timestamp
        const voiceName = voiceInput?.value?.trim() || ('clone-' + Date.now());
        formData.append('name', voiceName);
        formData.append('file', file);  // AetherMesh API expects "file", not "audio"
        const res = await fetch(apiUrl('/person-card/clone-voice'), {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '克隆失败');
        const voiceId = data.voice_id;
        if (voiceInput) voiceInput.value = voiceId;
        showCloneStatus(`克隆成功：${voiceId}`);
        saveVoiceId(voiceId);
      } catch (err) {
        showCloneStatus(err.message, true);
      } finally {
        cloneBtn.disabled = false;
        cloneFile.value = '';
      }
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const vid = voiceInput?.value?.trim();
      if (!vid || !currentCard?.name) { showCloneStatus('请先输入或克隆声音 ID', true); return; }
      showCloneStatus('试听中…');
      testBtn.disabled = true;
      try {
        await saveVoiceId(vid);
        let ttsLang = 'zh-tw';
        try {
          const cfgResp = await fetch(apiUrl('/settings/tts'));
          if (cfgResp.ok) {
            const cfg = await cfgResp.json();
            ttsLang = cfg?.tts?.aethermeshLanguage || 'zh-cn';
          }
        } catch {}
        const testText = ttsLang.startsWith('en')
          ? `Hello, this is a voice test for ${currentCard.name}.`
          : ttsLang.startsWith('es')
            ? `Hola, esta es una prueba de voz para ${currentCard.name}.`
            : ttsLang.startsWith('ja')
              ? `こんにちは、${currentCard.name}さんの音声テストです。`
              : ttsLang.startsWith('ko')
                ? `안녕하세요, ${currentCard.name}님의 음성 테스트입니다.`
                : `你好，这是为 ${currentCard.name} 设定的声音试听。`;
        const ttsResp = await fetch(apiUrl('/tts/stream'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: testText, voiceId: vid, language: ttsLang }),
        });
        if (!ttsResp.ok) throw new Error(`HTTP ${ttsResp.status}`);
        const blob = await ttsResp.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); showCloneStatus(''); };
        audio.play();
        showCloneStatus('播放中…');
      } catch (err) {
        showCloneStatus(`试听失败: ${err.message}`, true);
      } finally {
        testBtn.disabled = false;
      }
    });
  }
}
