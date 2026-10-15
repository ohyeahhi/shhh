(function () {
  'use strict';

  const STORE_KEY = 'shhh:baby:v1';
  const FADE = 1.5; // 재생/정지/소리 바꿀 때 페이드 시간(초)
  const TIMER_FADE = 30; // 자동 끄기 직전 서서히 줄어드는 시간(초)
  const NIGHT_IDLE = 20; // 재생 중 이 시간(초) 동안 손대지 않으면 화면 어둡게
  const MAX_LEVEL = 10;
  const MAX_LAYERS = 4; // 겹칠 수 있는 소리 수
  const LAYER_DEFAULT = 7; // 겹친 소리 하나하나의 기본 크기(1..10)

  const $ = (sel) => document.querySelector(sel);
  const playBtn = $('#play');
  const soundsEl = $('#sounds');
  const soundTpl = $('#sound-tpl');
  const mixTpl = $('#mix-tpl');
  const nowCard = $('#now-card');
  const nowEmoji = $('#now-emoji');
  const nowName = $('#now-name');
  const nowStatus = $('#now-status');
  const mixEl = $('#mix');
  const levelValue = $('#level-value');
  const levelFill = $('#level-fill');
  const levelMeter = $('#level-meter');
  const levelDown = $('#level-down');
  const levelUp = $('#level-up');
  const timerChips = document.querySelectorAll('#timer-chips button');
  const night = $('#night');
  const nightSound = $('#night-sound');
  const nightRemaining = $('#night-remaining');
  const presetList = $('#preset-list');
  const presetForm = $('#preset-form');
  const presetName = $('#preset-name');
  const presetSave = $('#preset-save');
  const toastEl = $('#toast');

  // 기본 제공 설정 (삭제 불가)
  const BUILTIN_PRESETS = [
    { id: 'b-nap', name: '낮잠', layers: [{ id: 'shush', level: 7 }], level: 5, timer: 30 },
    { id: 'b-night', name: '밤잠', layers: [{ id: 'womb', level: 7 }], level: 4, timer: 0 },
    { id: 'b-rain', name: '비 오는 밤', layers: [{ id: 'rain', level: 7 }, { id: 'womb', level: 5 }], level: 4, timer: 60 },
    { id: 'b-forest', name: '숲속', layers: [{ id: 'stream', level: 7 }, { id: 'birds', level: 5 }, { id: 'wind', level: 4 }], level: 5, timer: 30 },
  ];

  const byId = {};
  Noise.sounds.forEach((s) => { byId[s.id] = s; });

  const state = migrate(load());

  let ctx = null;
  let masterGain = null;
  let playing = false;
  const nodes = {}; // 소리 id -> { source, gain }
  const buffers = {};
  let timerEnd = 0;
  let wakeLock = null;
  let idleTimer = null;
  let toastTimer = null;

  // ---------- 저장 ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  // 예전 형식(소리 하나만 저장)을 겹치기 형식으로 바꾸고, 없어진 소리는 걸러냄
  function cleanLayers(layers, fallbackId) {
    let out = Array.isArray(layers) ? layers.filter((l) => l && byId[l.id]) : [];
    if (!out.length && byId[fallbackId]) out = [{ id: fallbackId, level: LAYER_DEFAULT }];
    return out.slice(0, MAX_LAYERS);
  }
  function migrate(saved) {
    const st = Object.assign({ level: 5, timer: 30, presets: [] }, saved);
    st.layers = cleanLayers(st.layers, st.sound);
    if (!st.layers.length) st.layers = [{ id: 'shush', level: LAYER_DEFAULT }];
    delete st.sound;
    st.presets = (Array.isArray(st.presets) ? st.presets : [])
      .map((p) => {
        const layers = cleanLayers(p.layers, p.sound);
        return { id: p.id, name: p.name, layers, level: p.level, timer: p.timer };
      })
      .filter((p) => p.layers.length);
    return st;
  }

  // ---------- 오디오 ----------
  function ensureContext() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    // iOS Safari: 무음 모드에서도 소리가 나도록
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'playback'; } catch (_) {}
    }
    masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    // 여러 소리를 겹쳐도 찢어지는 소리가 나지 않게 막아주는 리미터
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    masterGain.connect(limiter);
    limiter.connect(ctx.destination);
  }

  // 전체 크기 단계(1..10)를 귀에 자연스러운 곡선으로 변환. 최대치도 넉넉히 낮게 잡음.
  function levelGain(level) { return 0.85 * Math.pow(level / MAX_LEVEL, 2); }
  // 겹친 소리 하나의 크기: 기본값(7)일 때 보정값 그대로
  function layerGain(layer) {
    return (byId[layer.id].gain || 1) * Math.pow(layer.level / LAYER_DEFAULT, 2);
  }

  function ramp(param, value, seconds) {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  function startNode(layer) {
    const sound = byId[layer.id];
    if (!buffers[layer.id]) buffers[layer.id] = Noise.makeBuffer(ctx, sound);

    const source = ctx.createBufferSource();
    source.buffer = buffers[layer.id];
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    let head = source;
    if (sound.filter) {
      const f = ctx.createBiquadFilter();
      f.type = sound.filter.type;
      f.frequency.value = sound.filter.frequency;
      if (sound.filter.Q) f.Q.value = sound.filter.Q;
      source.connect(f);
      head = f;
    }
    head.connect(gain);
    gain.connect(masterGain);
    source.start();
    ramp(gain.gain, layerGain(layer), FADE);
    nodes[layer.id] = { source, gain };
  }

  function stopNode(id) {
    const n = nodes[id];
    if (!n) return;
    delete nodes[id];
    ramp(n.gain.gain, 0, FADE);
    n.source.stop(ctx.currentTime + FADE + 0.05);
  }

  // 재생 중인 소리를 state.layers에 맞춤: 새 소리는 켜고, 빠진 소리는 끄고, 크기는 맞춤
  function syncAudio(seconds) {
    if (!playing) return;
    const wanted = {};
    state.layers.forEach((l) => {
      wanted[l.id] = true;
      if (nodes[l.id]) ramp(nodes[l.id].gain.gain, layerGain(l), seconds);
      else startNode(l);
    });
    Object.keys(nodes).forEach((id) => { if (!wanted[id]) stopNode(id); });
  }

  async function play() {
    ensureContext();
    await ctx.resume();
    playing = true;
    syncAudio(FADE);
    timerEnd = state.timer ? Date.now() + state.timer * 60 * 1000 : 0;
    applyMaster();
    requestWakeLock();
    resetIdle();
    update();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    timerEnd = 0;
    ramp(masterGain.gain, 0, FADE);
    setTimeout(() => {
      if (!playing) {
        Object.keys(nodes).forEach((id) => {
          nodes[id].source.stop();
          delete nodes[id];
        });
        ctx.suspend();
      }
    }, FADE * 1000 + 100);
    releaseWakeLock();
    hideNight();
    update();
  }

  // 전체 볼륨 적용 + 자동 끄기 직전 페이드아웃 예약
  function applyMaster() {
    if (!playing) return;
    const g = masterGain.gain;
    const level = levelGain(state.level);
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (!timerEnd) {
      g.linearRampToValueAtTime(level, now + FADE);
      return;
    }
    const left = (timerEnd - Date.now()) / 1000;
    if (left > TIMER_FADE) {
      g.linearRampToValueAtTime(level, now + Math.min(FADE, left - TIMER_FADE));
      g.setValueAtTime(level, now + left - TIMER_FADE);
    }
    g.linearRampToValueAtTime(0, now + Math.max(left, 0.1));
  }

  // 레이어가 바뀐 뒤 공통 처리: 재생 중이면 소리 맞추고, 아니면 재생 시작
  function layersChanged() {
    if (playing) syncAudio(FADE);
    else play();
    save();
    update();
  }

  function findLayer(id) {
    return state.layers.find((l) => l.id === id);
  }

  // 소리 줄을 누름: 이 소리 하나로 바꿈
  function soloSound(id) {
    const existing = findLayer(id);
    state.layers = [{ id, level: existing ? existing.level : LAYER_DEFAULT }];
    layersChanged();
  }

  // ＋ 버튼: 겹치기 켜고 끄기
  function toggleLayer(id) {
    if (findLayer(id)) {
      if (state.layers.length === 1) {
        toast('소리가 하나는 있어야 해요');
        return;
      }
      state.layers = state.layers.filter((l) => l.id !== id);
    } else {
      if (state.layers.length >= MAX_LAYERS) {
        toast('소리는 ' + MAX_LAYERS + '개까지 겹칠 수 있어요');
        return;
      }
      state.layers.push({ id, level: LAYER_DEFAULT });
      toast(byId[id].name + ' 소리를 겹쳤어요');
    }
    layersChanged();
  }

  function setLayerLevel(id, delta) {
    const l = findLayer(id);
    if (!l) return;
    l.level = Math.max(1, Math.min(MAX_LEVEL, l.level + delta));
    syncAudio(0.1);
    save();
    update();
  }

  function setLevel(level) {
    state.level = Math.max(1, Math.min(MAX_LEVEL, level));
    applyMaster();
    save();
    update();
  }

  function setTimer(min) {
    state.timer = min;
    if (playing) {
      timerEnd = min ? Date.now() + min * 60 * 1000 : 0;
      applyMaster();
    }
    save();
    update();
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2000);
  }

  // ---------- 화면 켜둠 / 어둡게 ----------
  // 화면이 꺼지면 브라우저가 소리를 멈출 수 있어서, 재생 중에는 화면을 켜두고
  // 대신 검은 화면으로 덮어 빛을 최소로 줄입니다.
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) {}
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playing) requestWakeLock();
  });

  function showNight() {
    night.hidden = false;
    update();
  }
  function hideNight() {
    night.hidden = true;
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    if (playing) idleTimer = setTimeout(showNight, NIGHT_IDLE * 1000);
  }
  ['pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, resetIdle));
  night.addEventListener('click', hideNight);

  // ---------- 프리셋 ----------
  function sameLayers(a, b) {
    if (a.length !== b.length) return false;
    return a.every((x) => b.some((y) => y.id === x.id && y.level === x.level));
  }
  function matches(p) {
    return sameLayers(p.layers, state.layers) && p.level === state.level && p.timer === state.timer;
  }
  function copyLayers(layers) {
    return layers.map((l) => ({ id: l.id, level: l.level }));
  }

  function applyPreset(p) {
    state.layers = copyLayers(p.layers);
    state.level = p.level;
    state.timer = p.timer;
    if (playing) {
      syncAudio(FADE);
      timerEnd = p.timer ? Date.now() + p.timer * 60 * 1000 : 0;
      applyMaster();
      save();
      update();
    } else {
      layersChanged();
    }
  }

  function renderPresets() {
    presetList.textContent = '';
    BUILTIN_PRESETS.concat(state.presets).forEach((p) => {
      const el = document.createElement('div');
      el.className = 'preset' + (matches(p) ? ' active' : '');

      const apply = document.createElement('button');
      apply.className = 'apply';
      apply.textContent = p.name;
      apply.addEventListener('click', () => applyPreset(p));
      el.appendChild(apply);

      if (p.id.startsWith('u-')) {
        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '×';
        del.setAttribute('aria-label', p.name + ' 삭제');
        // 한 번 누르면 '삭제' 확인 상태, 다시 누르면 삭제
        del.addEventListener('click', () => {
          if (el.classList.contains('confirm')) {
            state.presets = state.presets.filter((x) => x.id !== p.id);
            save();
            renderPresets();
            return;
          }
          el.classList.add('confirm');
          del.textContent = '삭제';
          setTimeout(() => {
            el.classList.remove('confirm');
            del.textContent = '×';
          }, 3000);
        });
        el.appendChild(del);
      }
      presetList.appendChild(el);
    });
  }

  function closePresetForm() {
    presetForm.hidden = true;
    presetName.value = '';
    updateSaveLabel();
  }
  // 같은 이름이 있으면 버튼이 '덮어쓰기'로 바뀜
  function updateSaveLabel() {
    const name = presetName.value.trim();
    presetSave.textContent = state.presets.some((p) => p.name === name) ? '덮어쓰기' : '저장';
  }
  presetName.addEventListener('input', updateSaveLabel);
  presetName.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePresetForm(); });
  $('#preset-add').addEventListener('click', () => {
    presetForm.hidden = false;
    presetName.focus();
  });
  $('#preset-cancel').addEventListener('click', closePresetForm);
  presetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = presetName.value.trim();
    if (!name) return;
    const setting = { layers: copyLayers(state.layers), level: state.level, timer: state.timer };
    const existing = state.presets.find((p) => p.name === name);
    if (existing) Object.assign(existing, setting);
    else state.presets.push(Object.assign({ id: 'u-' + Date.now(), name }, setting));
    save();
    closePresetForm();
    renderPresets();
    toast('"' + name + '" 설정을 저장했어요');
  });

  // ---------- 화면 갱신 ----------
  function formatLeft() {
    if (!timerEnd) return '';
    const left = Math.max(0, Math.round((timerEnd - Date.now()) / 1000));
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  function timerLabel(min) {
    return min >= 60 ? min / 60 + '시간' : min + '분';
  }
  function statusText() {
    if (!playing) {
      return state.timer ? timerLabel(state.timer) + ' 뒤에 꺼지도록 준비했어요' : '끄지 않고 계속 들려줘요';
    }
    return timerEnd ? '재우는 중 · ' + formatLeft() + ' 남았어요' : '재우는 중 · 계속 들려줘요';
  }
  function layerNames() {
    return state.layers.map((l) => byId[l.id].name).join(' + ');
  }

  function renderMix() {
    mixEl.textContent = '';
    mixEl.hidden = state.layers.length < 2;
    if (mixEl.hidden) return;
    state.layers.forEach((l) => {
      const s = byId[l.id];
      const row = mixTpl.content.firstElementChild.cloneNode(true);
      row.querySelector('.mix-icon').textContent = s.emoji;
      row.querySelector('.mix-name').textContent = s.name;
      row.querySelector('.mini-fill').style.width = (l.level / MAX_LEVEL) * 100 + '%';
      const down = row.querySelector('.mix-down');
      const up = row.querySelector('.mix-up');
      down.setAttribute('aria-label', s.name + ' 작게');
      up.setAttribute('aria-label', s.name + ' 크게');
      down.disabled = l.level <= 1;
      up.disabled = l.level >= MAX_LEVEL;
      down.addEventListener('click', () => setLayerLevel(l.id, -1));
      up.addEventListener('click', () => setLayerLevel(l.id, 1));
      const remove = row.querySelector('.mix-remove');
      remove.setAttribute('aria-label', s.name + ' 빼기');
      remove.addEventListener('click', () => toggleLayer(l.id));
      mixEl.appendChild(row);
    });
  }

  function update() {
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.textContent = playing ? '그만하기' : '재우기';
    nowCard.classList.toggle('playing', playing);
    nowEmoji.textContent = byId[state.layers[0].id].emoji;
    const first = byId[state.layers[0].id].name;
    nowName.textContent = state.layers.length > 1 ? first + ' 외 ' + (state.layers.length - 1) + '개' : first;
    nowStatus.textContent = statusText();
    nightSound.textContent = layerNames();
    nightRemaining.textContent = timerEnd ? formatLeft() + ' 남았어요' : '계속 들려주는 중';
    renderMix();

    soundsEl.querySelectorAll('.sound').forEach((el) => {
      const on = !!findLayer(el.dataset.id);
      el.classList.toggle('on', on);
      const btn = el.querySelector('.layer-btn');
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', byId[el.dataset.id].name + (on ? ' 빼기' : ' 겹치기'));
    });

    levelValue.textContent = state.level + ' / ' + MAX_LEVEL;
    levelFill.style.width = (state.level / MAX_LEVEL) * 100 + '%';
    levelMeter.setAttribute('aria-valuenow', state.level);
    levelDown.disabled = state.level <= 1;
    levelUp.disabled = state.level >= MAX_LEVEL;

    timerChips.forEach((c) => c.setAttribute('aria-checked', String(Number(c.dataset.min) === state.timer)));

    renderPresets();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  setInterval(() => {
    if (!playing || !timerEnd) return;
    if (Date.now() >= timerEnd) stop();
    else {
      nowStatus.textContent = statusText();
      nightRemaining.textContent = formatLeft() + ' 남았어요';
    }
  }, 1000);

  // ---------- 화면 만들기 ----------
  Noise.groups.forEach((g) => {
    const section = document.createElement('section');
    section.className = 'group';
    const h = document.createElement('h2');
    h.textContent = g.name;
    const list = document.createElement('div');
    list.className = 'card list';
    section.append(h, list);

    Noise.sounds.filter((s) => s.group === g.id).forEach((s) => {
      const el = soundTpl.content.firstElementChild.cloneNode(true);
      el.dataset.id = s.id;
      el.querySelector('.sound-icon').textContent = s.emoji;
      el.querySelector('.name').textContent = s.name;
      el.querySelector('.desc').textContent = s.desc;
      el.querySelector('.sound-main').addEventListener('click', () => soloSound(s.id));
      el.querySelector('.layer-btn').addEventListener('click', () => toggleLayer(s.id));
      list.appendChild(el);
    });
    soundsEl.appendChild(section);
  });

  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  levelDown.addEventListener('click', () => setLevel(state.level - 1));
  levelUp.addEventListener('click', () => setLevel(state.level + 1));
  timerChips.forEach((c) => c.addEventListener('click', () => setTimer(Number(c.dataset.min))));
  $('#night-btn').addEventListener('click', () => {
    if (!playing) play();
    showNight();
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: '아기 재우기', artist: 'shhh' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', stop);
    } catch (_) {}
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  update();
})();
