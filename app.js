(function () {
  'use strict';

  const STORE_KEY = 'shhh:baby:v1';
  const FADE = 1.5; // 재생/정지/소리 바꿀 때 페이드 시간(초)
  const TIMER_FADE = 30; // 자동 끄기 직전 서서히 줄어드는 시간(초)
  const NIGHT_IDLE = 20; // 재생 중 이 시간(초) 동안 손대지 않으면 화면 어둡게
  const MAX_LEVEL = 10;

  const $ = (sel) => document.querySelector(sel);
  const playBtn = $('#play');
  const playLabel = playBtn.querySelector('.play-label');
  const soundsEl = $('#sounds');
  const tpl = $('#sound-tpl');
  const nowSoundEl = $('#now-sound');
  const remainingEl = $('#remaining');
  const levelDots = $('#level-dots');
  const levelDown = $('#level-down');
  const levelUp = $('#level-up');
  const timerChips = document.querySelectorAll('#timer-chips .chip');
  const night = $('#night');
  const nightSound = $('#night-sound');
  const nightRemaining = $('#night-remaining');
  const presetList = $('#preset-list');
  const presetForm = $('#preset-form');
  const presetName = $('#preset-name');
  const presetSave = $('#preset-save');

  // 기본 제공 설정 (삭제 불가)
  const BUILTIN_PRESETS = [
    { id: 'b-nap', name: '낮잠', sound: 'shush', level: 5, timer: 30 },
    { id: 'b-night', name: '밤잠', sound: 'womb', level: 4, timer: 0 },
  ];

  const byId = {};
  Noise.sounds.forEach((s) => { byId[s.id] = s; });

  const state = Object.assign({ sound: 'shush', level: 5, timer: 30, presets: [] }, load());
  if (!byId[state.sound]) state.sound = 'shush';
  if (!Array.isArray(state.presets)) state.presets = [];

  let ctx = null;
  let masterGain = null;
  let playing = false;
  let current = null; // { id, source, gain }
  const buffers = {};
  let timerEnd = 0;
  let wakeLock = null;
  let idleTimer = null;

  // ---------- 저장 ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
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
    masterGain.connect(ctx.destination);
  }

  // 단계(1..10)를 귀에 자연스러운 곡선으로 변환. 최대치도 넉넉히 낮게 잡음.
  function levelGain(level) { return 0.85 * Math.pow(level / MAX_LEVEL, 2); }

  function ramp(param, value, seconds) {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  function startSound(id) {
    const sound = byId[id];
    if (!buffers[id]) buffers[id] = Noise.makeBuffer(ctx, sound);

    const source = ctx.createBufferSource();
    source.buffer = buffers[id];
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
    ramp(gain.gain, sound.gain || 1, FADE);
    current = { id, source, gain };
  }

  function stopCurrent() {
    if (!current) return;
    const { source, gain } = current;
    current = null;
    ramp(gain.gain, 0, FADE);
    source.stop(ctx.currentTime + FADE + 0.05);
  }

  async function play() {
    ensureContext();
    await ctx.resume();
    if (!current || current.id !== state.sound) {
      stopCurrent();
      startSound(state.sound);
    }
    playing = true;
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
        if (current) { current.source.stop(); current = null; }
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

  function selectSound(id) {
    state.sound = id;
    if (playing) {
      if (!current || current.id !== id) {
        stopCurrent();
        startSound(id);
      }
    } else {
      play();
    }
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
  function matches(p) {
    return p.sound === state.sound && p.level === state.level && p.timer === state.timer;
  }

  function applyPreset(p) {
    state.level = p.level;
    state.timer = p.timer;
    state.sound = p.sound;
    if (playing) {
      if (!current || current.id !== p.sound) {
        stopCurrent();
        startSound(p.sound);
      }
      timerEnd = p.timer ? Date.now() + p.timer * 60 * 1000 : 0;
      applyMaster();
    } else {
      play();
    }
    save();
    update();
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
    const setting = { sound: state.sound, level: state.level, timer: state.timer };
    const existing = state.presets.find((p) => p.name === name);
    if (existing) Object.assign(existing, setting);
    else state.presets.push(Object.assign({ id: 'u-' + Date.now(), name }, setting));
    save();
    closePresetForm();
    renderPresets();
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

  function update() {
    const sound = byId[state.sound];
    playBtn.setAttribute('aria-pressed', String(playing));
    playLabel.textContent = playing ? '그만' : '재우기';
    nowSoundEl.textContent = (playing ? '재우는 중 · ' : '') + sound.emoji + ' ' + sound.name;
    remainingEl.textContent = playing ? (timerEnd ? formatLeft() + ' 남음' : '') : '';
    nightSound.textContent = sound.name;
    nightRemaining.textContent = timerEnd ? formatLeft() + ' 남음' : '계속 재생 중';

    soundsEl.querySelectorAll('.sound').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.id === state.sound));
    });

    levelDots.querySelectorAll('span').forEach((d, i) => d.classList.toggle('on', i < state.level));
    levelDots.setAttribute('aria-valuenow', state.level);
    levelDown.disabled = state.level <= 1;
    levelUp.disabled = state.level >= MAX_LEVEL;

    timerChips.forEach((c) => c.classList.toggle('active', Number(c.dataset.min) === state.timer));

    renderPresets();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  setInterval(() => {
    if (!playing || !timerEnd) return;
    if (Date.now() >= timerEnd) stop();
    else {
      const t = formatLeft() + ' 남음';
      remainingEl.textContent = t;
      nightRemaining.textContent = t;
    }
  }, 1000);

  // ---------- 화면 만들기 ----------
  Noise.sounds.forEach((s) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = s.id;
    el.querySelector('.emoji').textContent = s.emoji;
    el.querySelector('.name').textContent = s.name;
    el.querySelector('.desc').textContent = s.desc;
    el.addEventListener('click', () => selectSound(s.id));
    soundsEl.appendChild(el);
  });
  // 볼륨 막대: 오른쪽으로 갈수록 높아짐
  for (let i = 0; i < MAX_LEVEL; i++) {
    const d = document.createElement('span');
    d.style.height = 30 + (i * 70) / (MAX_LEVEL - 1) + '%';
    levelDots.appendChild(d);
  }

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
