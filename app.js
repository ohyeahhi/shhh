(function () {
  'use strict';

  const STORE_KEY = 'shhh:v1';
  const FADE = 1.2; // 재생/정지 시 페이드 시간(초)
  const TIMER_FADE = 20; // 타이머 종료 직전 페이드아웃 시간(초)

  const $ = (sel) => document.querySelector(sel);
  const playBtn = $('#play');
  const masterInput = $('#master');
  const soundsEl = $('#sounds');
  const tpl = $('#sound-tpl');
  const remainingEl = $('#remaining');
  const chips = document.querySelectorAll('#timer-chips .chip');

  const state = load() || {
    master: 70,
    sounds: { rain: { on: true, vol: 60 } },
  };

  let ctx = null;
  let masterGain = null;
  let playing = false;
  const nodes = {}; // id -> { gain, source }
  const buffers = {};

  let timerEnd = 0;
  let timerId = null;

  // ---------- 저장 ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (_) { return null; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function soundState(id) {
    return state.sounds[id] || (state.sounds[id] = { on: false, vol: 60 });
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

  // 슬라이더 값(0..100)을 사람 귀에 자연스러운 곡선으로 변환
  function curve(v) { return Math.pow(v / 100, 2); }

  function ramp(param, value, seconds) {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  function startSound(sound) {
    if (nodes[sound.id]) return;
    if (!buffers[sound.id]) buffers[sound.id] = Noise.makeBuffer(ctx, sound);

    const source = ctx.createBufferSource();
    source.buffer = buffers[sound.id];
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    let head = source;
    if (sound.filter) {
      const f = ctx.createBiquadFilter();
      f.type = sound.filter.type;
      f.frequency.value = sound.filter.frequency;
      source.connect(f);
      head = f;
    }
    head.connect(gain);
    gain.connect(masterGain);
    // 같은 소리를 여러 번 켜도 똑같이 들리지 않도록 시작 위치를 무작위로
    source.start(0, Math.random() * source.buffer.duration);

    nodes[sound.id] = { source, gain };
    ramp(gain.gain, curve(soundState(sound.id).vol), FADE);
  }

  function stopSound(id) {
    const n = nodes[id];
    if (!n) return;
    delete nodes[id];
    ramp(n.gain.gain, 0, FADE);
    n.source.stop(ctx.currentTime + FADE + 0.05);
  }

  function anyOn() {
    return Noise.sounds.some((s) => soundState(s.id).on);
  }

  async function play() {
    ensureContext();
    if (!anyOn()) {
      soundState('pink').on = true;
      render();
    }
    await ctx.resume();
    Noise.sounds.forEach((s) => { if (soundState(s.id).on) startSound(s); });
    ramp(masterGain.gain, curve(state.master), FADE);
    playing = true;
    if (timerEnd) scheduleTimerFade();
    updatePlayUI();
    save();
  }

  function pause() {
    if (!ctx) return;
    playing = false;
    ramp(masterGain.gain, 0, FADE);
    const wasCtx = ctx;
    setTimeout(() => {
      if (!playing) {
        Object.keys(nodes).forEach((id) => {
          nodes[id].source.stop();
          delete nodes[id];
        });
        wasCtx.suspend();
      }
    }, FADE * 1000 + 100);
    updatePlayUI();
  }

  // ---------- 타이머 ----------
  function setTimer(min) {
    clearInterval(timerId);
    timerId = null;
    timerEnd = min ? Date.now() + min * 60 * 1000 : 0;
    chips.forEach((c) => c.classList.toggle('active', Number(c.dataset.min) === min));
    if (timerEnd) {
      timerId = setInterval(tick, 1000);
      if (playing) scheduleTimerFade();
    } else if (playing) {
      ramp(masterGain.gain, curve(state.master), FADE);
    }
    tick();
  }

  function scheduleTimerFade() {
    const left = (timerEnd - Date.now()) / 1000;
    if (left <= 0) return;
    const now = ctx.currentTime;
    const g = masterGain.gain;
    const level = curve(state.master);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (left > TIMER_FADE) {
      g.linearRampToValueAtTime(level, now + Math.min(FADE, left - TIMER_FADE));
      g.setValueAtTime(level, now + left - TIMER_FADE);
    }
    g.linearRampToValueAtTime(0, now + left);
  }

  function tick() {
    if (!timerEnd) {
      remainingEl.textContent = '';
      return;
    }
    const left = Math.max(0, Math.round((timerEnd - Date.now()) / 1000));
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    remainingEl.textContent = (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
    if (left === 0) {
      pause();
      setTimer(0);
    }
  }

  // ---------- UI ----------
  function updatePlayUI() {
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('aria-label', playing ? '일시정지' : '재생');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  function render() {
    Noise.sounds.forEach((s) => {
      const el = soundsEl.querySelector('[data-id="' + s.id + '"]');
      const st = soundState(s.id);
      el.classList.toggle('on', st.on);
      el.querySelector('.toggle').setAttribute('aria-pressed', String(st.on));
      el.querySelector('.vol').value = st.vol;
    });
  }

  function build() {
    Noise.sounds.forEach((s) => {
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.dataset.id = s.id;
      el.querySelector('.emoji').textContent = s.emoji;
      el.querySelector('.name').textContent = s.name;
      const vol = el.querySelector('.vol');
      vol.setAttribute('aria-label', s.name + ' 볼륨');

      el.querySelector('.toggle').addEventListener('click', () => {
        const st = soundState(s.id);
        st.on = !st.on;
        if (playing) {
          if (st.on) startSound(s); else stopSound(s.id);
          if (!anyOn()) pause();
        } else if (st.on) {
          play();
        }
        render();
        save();
      });

      vol.addEventListener('input', () => {
        const st = soundState(s.id);
        st.vol = Number(vol.value);
        if (!st.on) {
          st.on = true;
          if (playing) startSound(s); else play();
          render();
        } else if (nodes[s.id]) {
          ramp(nodes[s.id].gain.gain, curve(st.vol), 0.05);
        }
        save();
      });

      soundsEl.appendChild(el);
    });
    render();
  }

  playBtn.addEventListener('click', () => (playing ? pause() : play()));

  masterInput.value = state.master;
  masterInput.addEventListener('input', () => {
    state.master = Number(masterInput.value);
    if (playing) {
      ramp(masterGain.gain, curve(state.master), 0.05);
      if (timerEnd) scheduleTimerFade();
    }
    save();
  });

  chips.forEach((c) => c.addEventListener('click', () => setTimer(Number(c.dataset.min))));

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      playing ? pause() : play();
    }
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: '백색소음', artist: 'shhh' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
    } catch (_) {}
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  build();
})();
