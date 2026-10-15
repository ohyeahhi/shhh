// 소리 생성기: 모든 소리를 Web Audio로 직접 합성합니다 (음원 파일 없음).
// 각 생성기는 끊김 없이 반복 재생되는 AudioBuffer를 만듭니다.

(function () {
  'use strict';

  // fill(raw, rate, len)은 len + fade 길이의 배열을 채웁니다.
  // 버퍼 끝을 시작 부분과 크로스페이드해 반복 지점의 '틱' 소리를 없앱니다.
  // 박자나 모터음처럼 주기가 있는 소리는 len 안에 정수 주기가 들어가게 만들어
  // 크로스페이드 구간에서도 리듬과 위상이 그대로 이어집니다.
  function makeLoop(ctx, seconds, fill) {
    const rate = ctx.sampleRate;
    const len = Math.floor(seconds * rate);
    const fade = Math.floor(0.5 * rate);
    const raw = new Float32Array(len + fade);
    fill(raw, rate, len);

    const buffer = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const out = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        let v = raw[i];
        if (i < fade) {
          const t = i / fade;
          v = raw[i] * Math.sqrt(t) + raw[len + i] * Math.sqrt(1 - t);
        }
        out[i] = v;
      }
    }
    normalize(buffer, 0.5);
    return buffer;
  }

  function normalize(buffer, target) {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    if (!peak) return;
    const k = target / peak;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }

  function white(d) {
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // Paul Kellet의 핑크 노이즈 필터
  function pink(d) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }

  // 누설 적분기로 만든 브라운 노이즈
  function brown(d) {
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }

  // 배음이 섞인 모터음. f0 * 버퍼 길이(초)가 정수여야 반복이 매끄럽습니다.
  function motor(d, rate, f0, harmonics, amp) {
    for (let i = 0; i < d.length; i++) {
      const t = i / rate;
      let v = 0;
      for (let k = 1; k <= harmonics; k++) v += Math.sin(2 * Math.PI * f0 * k * t) / k;
      d[i] += v * amp;
    }
  }

  // 쉬~ 쉬~: 부모가 입으로 길게 내는 "쉬~~~~쉬~~~~~~" 소리.
  // 한 번에 4.5~6.5초씩 길게 내고, 숨 쉬는 틈은 약 0.2초로 아주 짧게 둡니다.
  // 틈에서도 소리가 완전히 끊기지 않고 살짝만 내려갔다 올라와서 거의 이어지게 들립니다.
  // 길이를 들쭉날쭉하게 섞어 기계적으로 들리지 않게 합니다.
  const SHUSH_PATTERN = [4.5, 6.0, 5.0, 6.5, 4.5, 5.5]; // 각 회차 길이(초, 틈 포함), 합계 32초
  const SHUSH_SECONDS = SHUSH_PATTERN.reduce((a, b) => a + b, 0);
  const SHUSH_FLOOR = 0.3; // 틈에서 남는 소리 크기 (0이면 완전히 끊김)

  function shush(d, rate, len) {
    white(d);
    const scale = len / (SHUSH_SECONDS * rate); // 반올림 오차 보정
    const env = new Float32Array(len).fill(SHUSH_FLOOR);
    const smooth = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));
    let pos = 0;
    SHUSH_PATTERN.forEach((sec) => {
      const total = Math.round(sec * rate * scale);
      const gap = Math.round((0.15 + Math.random() * 0.1) * rate);
      const body = total - gap;
      const attack = 0.2 * rate;
      const release = 0.3 * rate;
      const wobble = Math.random() * Math.PI * 2;
      for (let k = 0; k < body && pos + k < len; k++) {
        const t = k / body;
        // 숨이 줄어들며 끝으로 갈수록 살짝 약해지고, 미세하게 흔들림
        const level = (1 - 0.2 * t) * (1 + 0.04 * Math.sin(2 * Math.PI * 0.6 * (k / rate) + wobble));
        const shape = Math.min(smooth(k / attack), smooth((body - k) / release));
        env[pos + k] = SHUSH_FLOOR + (level - SHUSH_FLOOR) * shape;
      }
      pos += total;
    });
    for (let i = 0; i < d.length; i++) d[i] *= env[i % len];
  }

  // 엄마 뱃속: 낮은 혈류 소리 + 분당 72회 심장박동(쿵-쿵)
  function womb(d, rate, len) {
    brown(d);
    const beats = 12; // 10초 버퍼에 12박 = 72bpm
    const beatLen = len / beats;
    for (let i = 0; i < d.length; i++) {
      const t = ((i % len) % beatLen) / rate;
      const swell = 0.55 + 0.45 * Math.exp(-t / 0.3);
      let beat = 0;
      if (t < 0.25) beat += thump(t);
      const t2 = t - 0.3;
      if (t2 >= 0 && t2 < 0.25) beat += 0.6 * thump(t2);
      d[i] = d[i] * swell * 0.8 + beat;
    }
  }
  // 휴대폰 스피커에서도 들리도록 기본음 위에 배음을 얹은 '쿵'
  function thump(t) {
    const e = Math.exp(-t / 0.045) * Math.min(1, t / 0.004);
    return (Math.sin(2 * Math.PI * 70 * t) + 0.6 * Math.sin(2 * Math.PI * 140 * t)) * e * 1.1;
  }

  function dryer(d, rate) {
    white(d);
    for (let i = 0; i < d.length; i++) d[i] *= 0.6;
    motor(d, rate, 190, 6, 0.09);
  }

  function vacuum(d, rate) {
    pink(d);
    const w = new Float32Array(d.length);
    white(w);
    for (let i = 0; i < d.length; i++) d[i] = d[i] * 2.2 + w[i] * 0.35;
    motor(d, rate, 610, 4, 0.07);
    motor(d, rate, 120, 3, 0.05);
  }

  // 자동차 안: 낮은 도로 소음이 천천히 출렁입니다.
  function car(d, rate, len) {
    brown(d);
    const p = new Float32Array(d.length);
    pink(p);
    for (let i = 0; i < d.length; i++) {
      const t = (i % len) / len;
      const sway = 1 + 0.12 * Math.sin(2 * Math.PI * 2 * t) + 0.06 * Math.sin(2 * Math.PI * 5 * t + 1);
      d[i] = (d[i] + p[i] * 0.4) * sway;
    }
    motor(d, rate, 95, 3, 0.04);
  }

  // 이벤트(새 지저귐, 풀벌레 울음 등)를 버퍼 길이(len) 안에서 감싸 돌도록 더합니다.
  // 끝을 넘친 부분은 앞쪽으로 이어져서 반복 지점에서 소리가 잘리지 않습니다.
  function addWrapped(d, len, start, samples) {
    for (let k = 0; k < samples.length; k++) d[(start + k) % len] += samples[k];
  }
  // len 뒤쪽(크로스페이드용 여분)을 앞부분 복사로 채워 반복이 매끄럽게 함
  function copyTail(d, len) {
    for (let i = len; i < d.length; i++) d[i] = d[i - len];
  }

  // 파도: 브라운+핑크 노이즈에 느린 파도 엔벨로프를 입힘
  function ocean(d, rate, len) {
    const p = new Float32Array(d.length);
    brown(d);
    pink(p);
    const waves = [
      { cycles: 4, amp: 1, phase: 0 },
      { cycles: 3, amp: 0.5, phase: 1.3 },
      { cycles: 7, amp: 0.25, phase: 2.1 },
    ];
    for (let i = 0; i < d.length; i++) {
      const t = (i % len) / len;
      let env = 0;
      for (const w of waves) env += w.amp * Math.sin(2 * Math.PI * w.cycles * t + w.phase);
      env = Math.pow((env / 1.75 + 1) / 2, 2.2); // 0..1, 파도가 부서지는 느낌으로 날카롭게
      d[i] = (d[i] * 0.6 + p[i] * env * 1.2) * (0.25 + env);
    }
  }

  // 시냇물: 졸졸 흐르는 물소리 + 작은 물방울이 '퐁' 하고 터지는 소리
  function stream(d, rate, len) {
    pink(d);
    for (let i = 0; i < d.length; i++) d[i] *= 0.35;
    const bubbles = Math.floor((len / rate) * 45);
    for (let n = 0; n < bubbles; n++) {
      const f0 = 400 + Math.random() * 1400;
      const tau = 0.006 + Math.random() * 0.014;
      const dur = Math.floor(tau * 6 * rate);
      const amp = Math.pow(Math.random(), 2) * 0.5;
      const out = new Float32Array(dur);
      let phase = 0;
      for (let k = 0; k < dur; k++) {
        const t = k / rate;
        phase += (2 * Math.PI * f0 * (1 + (t / tau) * 0.15)) / rate; // 물방울은 음이 살짝 올라감
        out[k] = Math.sin(phase) * Math.exp(-t / tau) * amp * Math.min(1, k / 20);
      }
      addWrapped(d, len, Math.floor(Math.random() * len), out);
    }
    copyTail(d, len);
  }

  // 바람: 노이즈를 공명 필터에 통과시키고, 필터 음높이와 세기를 천천히 출렁이게 함
  function wind(d, rate, len) {
    let low = 0, band = 0;
    for (let i = 0; i < d.length; i++) {
      const t = (i % len) / len;
      const gust = 0.5 + 0.3 * Math.sin(2 * Math.PI * t + 0.5) + 0.15 * Math.sin(2 * Math.PI * 3 * t + 2) + 0.05 * Math.sin(2 * Math.PI * 7 * t);
      const fc = 180 + 650 * gust;
      const f = 2 * Math.sin((Math.PI * fc) / rate);
      const w = Math.random() * 2 - 1;
      const high = w - low - 0.5 * band;
      band += f * high;
      low += f * band;
      d[i] = (band * 0.7 + low * 0.3) * (0.3 + gust);
    }
  }

  // 풀벌레: 여름밤 귀뚜라미 세 마리가 각자 다른 박자로 '찌르르' 울음
  function crickets(d, rate, len) {
    pink(d);
    for (let i = 0; i < d.length; i++) d[i] *= 0.04;
    const bugs = [
      { freq: 4200, every: 0.62, pulses: 3, amp: 0.25 },
      { freq: 4700, every: 0.81, pulses: 4, amp: 0.15 },
      { freq: 5100, every: 1.07, pulses: 3, amp: 0.1 },
    ];
    bugs.forEach((b) => {
      const pulseLen = Math.floor(0.018 * rate);
      const step = Math.floor(0.032 * rate);
      const chirp = new Float32Array(step * b.pulses);
      for (let p = 0; p < b.pulses; p++) {
        for (let k = 0; k < pulseLen; k++) {
          const e = Math.sin((Math.PI * k) / pulseLen);
          chirp[p * step + k] = Math.sin((2 * Math.PI * b.freq * k) / rate) * e * e * b.amp;
        }
      }
      for (let t = Math.random() * b.every; t < len / rate; t += b.every * (0.9 + Math.random() * 0.2)) {
        addWrapped(d, len, Math.floor(t * rate), chirp);
      }
    });
    copyTail(d, len);
  }

  // 새소리: 서로 다른 새 두세 마리가 띄엄띄엄 지저귐 + 아주 작은 나뭇잎 소리
  function birds(d, rate, len) {
    pink(d);
    for (let i = 0; i < d.length; i++) d[i] *= 0.03;
    const species = [
      // 위에서 아래로 떨어지는 '삐요'
      { lo: 2600, hi: 4200, dur: [0.08, 0.16], notes: [3, 6], gap: 0.06, shape: 'down', amp: 0.35 },
      // 빠르게 떨리는 '찌르릇'
      { lo: 3800, hi: 5200, dur: [0.15, 0.3], notes: [1, 3], gap: 0.12, shape: 'trill', amp: 0.2 },
      // 올라가는 '휘익'
      { lo: 2000, hi: 3400, dur: [0.2, 0.35], notes: [1, 2], gap: 0.2, shape: 'up', amp: 0.25 },
    ];
    const seconds = len / rate;
    species.forEach((sp, si) => {
      let t = Math.random() * 2 + si;
      while (t < seconds) {
        const notes = sp.notes[0] + Math.floor(Math.random() * (sp.notes[1] - sp.notes[0] + 1));
        let nt = t;
        for (let n = 0; n < notes; n++) {
          const dur = sp.dur[0] + Math.random() * (sp.dur[1] - sp.dur[0]);
          const samples = Math.floor(dur * rate);
          const out = new Float32Array(samples);
          const jitter = 1 + (Math.random() - 0.5) * 0.1;
          let phase = 0;
          for (let k = 0; k < samples; k++) {
            const x = k / samples;
            let f;
            if (sp.shape === 'down') f = sp.hi - (sp.hi - sp.lo) * x;
            else if (sp.shape === 'up') f = sp.lo + (sp.hi - sp.lo) * x * x;
            else f = (sp.lo + sp.hi) / 2 + ((sp.hi - sp.lo) / 2) * Math.sin(2 * Math.PI * 28 * x * dur);
            phase += (2 * Math.PI * f * jitter) / rate;
            const e = Math.sin(Math.PI * x);
            out[k] = Math.sin(phase) * e * e * sp.amp;
          }
          addWrapped(d, len, Math.floor(nt * rate), out);
          nt += dur + sp.gap;
        }
        t = nt + 2 + Math.random() * 4; // 다음 지저귐까지 2~6초 쉼
      }
    });
    copyTail(d, len);
  }

  // 모닥불: 낮은 웅웅거림 + 타닥거리는 소리
  function fire(d, rate) {
    brown(d);
    for (let i = 0; i < d.length; i++) d[i] *= 0.5;
    const crackles = Math.floor((d.length / rate) * 12);
    for (let n = 0; n < crackles; n++) {
      const start = Math.floor(Math.random() * d.length);
      const burst = 1 + Math.floor(Math.random() * 4);
      for (let b = 0; b < burst; b++) {
        const s = start + Math.floor(Math.random() * 0.08 * rate);
        const amp = 0.3 + Math.random() * 0.9;
        const len = Math.floor((0.001 + Math.random() * 0.003) * rate);
        for (let k = 0; k < len && s + k < d.length; k++) {
          d[s + k] += (Math.random() * 2 - 1) * amp * (1 - k / len);
        }
      }
    }
  }

  // 빗소리: 높은 대역의 쉬익 소리 + 무작위 빗방울
  function rain(d, rate) {
    pink(d);
    for (let i = 0; i < d.length; i++) d[i] *= 0.6;
    const drops = Math.floor((d.length / rate) * 180);
    for (let n = 0; n < drops; n++) {
      const start = Math.floor(Math.random() * d.length);
      const amp = Math.pow(Math.random(), 3) * 0.9;
      const decay = 0.0015 + Math.random() * 0.004;
      const len = Math.floor(decay * 6 * rate);
      let prev = 0;
      for (let k = 0; k < len && start + k < d.length; k++) {
        const w = Math.random() * 2 - 1;
        const hp = w - prev; // 단순 고역 통과로 '톡' 하는 질감
        prev = w;
        d[start + k] += hp * amp * Math.exp(-k / (decay * rate));
      }
    }
  }

  // 선풍기: 부드러운 브라운 노이즈 + 날개의 미세한 회전 맥동
  function fan(d, rate, len) {
    brown(d);
    const p = new Float32Array(d.length);
    pink(p);
    for (let i = 0; i < d.length; i++) {
      const t = (i % len) / rate;
      const pulse = 1 + 0.06 * Math.sin(2 * Math.PI * 14 * t);
      d[i] = (d[i] + p[i] * 0.35) * pulse;
    }
  }

  // gain: 소리마다 체감 크기를 비슷하게 맞추는 보정값 (필터 후 RMS 기준 약 -21dB).
  // 풀벌레·새소리처럼 높고 띄엄띄엄한 소리는 RMS보다 크게 들려서 조금 낮게 잡음.
  window.Noise = {
    groups: [
      { id: 'baby', name: '아기 재우기' },
      { id: 'home', name: '생활 소리' },
      { id: 'nature', name: '자연의 소리' },
    ],
    sounds: [
      { id: 'shush', group: 'baby', gain: 0.95, name: '쉬~ 쉬~', emoji: '🤫', desc: '엄마 아빠가 내는 쉬~ 소리', seconds: SHUSH_SECONDS, fill: shush, filter: { type: 'bandpass', frequency: 3000, Q: 0.6 } },
      { id: 'womb', group: 'baby', gain: 1.4, name: '엄마 뱃속', emoji: '🤰', desc: '심장 소리와 뱃속 소리', seconds: 10, fill: womb, filter: { type: 'lowpass', frequency: 600 } },
      { id: 'white', group: 'baby', gain: 0.56, name: '백색소음', emoji: '☁️', desc: '쏴~ 하는 기본 소리', seconds: 6, fill: white, filter: { type: 'lowpass', frequency: 9000 } },
      { id: 'dryer', group: 'home', gain: 0.77, name: '드라이기', emoji: '💨', desc: '헤어드라이어 소리', seconds: 10, fill: dryer, filter: { type: 'lowpass', frequency: 6000 } },
      { id: 'vacuum', group: 'home', gain: 0.8, name: '청소기', emoji: '🧹', desc: '윙~ 하는 청소기 소리', seconds: 10, fill: vacuum, filter: { type: 'lowpass', frequency: 7000 } },
      { id: 'car', group: 'home', gain: 0.9, name: '자동차 안', emoji: '🚗', desc: '차만 타면 자는 아기에게', seconds: 10, fill: car, filter: { type: 'lowpass', frequency: 400 } },
      { id: 'fan', group: 'home', gain: 0.83, name: '선풍기', emoji: '🌀', desc: '일정한 바람 소리', seconds: 10, fill: fan, filter: { type: 'lowpass', frequency: 900 } },
      { id: 'rain', group: 'nature', gain: 2.0, name: '빗소리', emoji: '🌧️', desc: '잔잔하게 내리는 비', seconds: 12, fill: rain, filter: { type: 'highpass', frequency: 400 } },
      { id: 'ocean', group: 'nature', gain: 1.65, name: '파도', emoji: '🌊', desc: '밀려왔다 밀려가는 바다', seconds: 40, fill: ocean, filter: { type: 'lowpass', frequency: 1800 } },
      { id: 'stream', group: 'nature', gain: 1.5, name: '시냇물', emoji: '💧', desc: '졸졸 흐르는 물소리', seconds: 12, fill: stream, filter: { type: 'lowpass', frequency: 6000 } },
      { id: 'wind', group: 'nature', gain: 1.15, name: '바람', emoji: '🍃', desc: '창밖에 부는 바람', seconds: 20, fill: wind, filter: null },
      { id: 'crickets', group: 'nature', gain: 1.2, name: '풀벌레', emoji: '🦗', desc: '여름밤 귀뚜라미', seconds: 10, fill: crickets, filter: { type: 'highpass', frequency: 200 } },
      { id: 'birds', group: 'nature', gain: 1.2, name: '새소리', emoji: '🐦', desc: '아침 숲속 지저귐', seconds: 20, fill: birds, filter: { type: 'highpass', frequency: 300 } },
      { id: 'fire', group: 'nature', gain: 2.5, name: '모닥불', emoji: '🔥', desc: '타닥타닥 장작 타는 소리', seconds: 15, fill: fire, filter: { type: 'lowpass', frequency: 5000 } },
    ],
    makeBuffer(ctx, sound) {
      return makeLoop(ctx, sound.seconds, sound.fill);
    },
  };
})();
