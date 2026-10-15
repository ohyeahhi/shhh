// 소리 생성기: 모든 소리를 Web Audio로 직접 합성합니다 (음원 파일 없음).
// 각 생성기는 끊김 없이 반복 재생되는 AudioBuffer를 만듭니다.

(function () {
  'use strict';

  // 버퍼 끝을 시작 부분과 크로스페이드해 반복 지점의 '틱' 소리를 없앱니다.
  function makeLoop(ctx, seconds, fill) {
    const rate = ctx.sampleRate;
    const len = Math.floor(seconds * rate);
    const fade = Math.floor(0.5 * rate);
    const raw = new Float32Array(len + fade);
    fill(raw, rate);

    const buffer = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const out = buffer.getChannelData(ch);
      // 채널마다 오프셋을 줘서 약간의 스테레오 폭을 만듭니다.
      const offset = ch === 0 ? 0 : Math.floor(len / 3);
      for (let i = 0; i < len; i++) {
        let j = (i + offset) % len;
        let v = raw[j];
        if (j < fade) {
          const t = j / fade;
          v = raw[j] * Math.sqrt(t) + raw[len + j] * Math.sqrt(1 - t);
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

  // 파도: 브라운+핑크 노이즈에 느린 파도 엔벨로프를 입힘
  function ocean(d, rate) {
    const p = new Float32Array(d.length);
    brown(d);
    pink(p);
    const seconds = d.length / rate;
    // 버퍼 길이 안에 정수 주기만 넣어 반복 지점이 자연스럽도록 함
    const waves = [
      { cycles: Math.round(seconds / 9), amp: 1, phase: 0 },
      { cycles: Math.round(seconds / 13), amp: 0.5, phase: 1.3 },
      { cycles: Math.round(seconds / 5.5), amp: 0.25, phase: 2.1 },
    ];
    for (let i = 0; i < d.length; i++) {
      const t = i / d.length;
      let env = 0;
      for (const w of waves) env += w.amp * Math.sin(2 * Math.PI * w.cycles * t + w.phase);
      env = Math.pow((env / 1.75 + 1) / 2, 2.2); // 0..1, 파도가 부서지는 느낌으로 날카롭게
      d[i] = (d[i] * 0.6 + p[i] * env * 1.2) * (0.25 + env);
    }
  }

  // 선풍기: 부드러운 브라운 노이즈 + 날개의 미세한 회전 맥동
  function fan(d, rate) {
    brown(d);
    const p = new Float32Array(d.length);
    pink(p);
    const seconds = d.length / rate;
    const cycles = Math.round(seconds * 14); // 약 14Hz 맥동
    for (let i = 0; i < d.length; i++) {
      const t = i / d.length;
      const pulse = 1 + 0.06 * Math.sin(2 * Math.PI * cycles * t);
      d[i] = (d[i] + p[i] * 0.35) * pulse;
    }
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

  window.Noise = {
    sounds: [
      { id: 'white', name: '화이트', emoji: '⚪', seconds: 6, fill: white, filter: null },
      { id: 'pink', name: '핑크', emoji: '🌸', seconds: 6, fill: pink, filter: null },
      { id: 'brown', name: '브라운', emoji: '🟤', seconds: 8, fill: brown, filter: null },
      { id: 'rain', name: '빗소리', emoji: '🌧️', seconds: 12, fill: rain, filter: { type: 'highpass', frequency: 400 } },
      { id: 'ocean', name: '파도', emoji: '🌊', seconds: 40, fill: ocean, filter: { type: 'lowpass', frequency: 1800 } },
      { id: 'fan', name: '선풍기', emoji: '🌀', seconds: 10, fill: fan, filter: { type: 'lowpass', frequency: 900 } },
      { id: 'fire', name: '모닥불', emoji: '🔥', seconds: 15, fill: fire, filter: { type: 'lowpass', frequency: 5000 } },
      { id: 'deep', name: '깊은 저음', emoji: '🌌', seconds: 8, fill: brown, filter: { type: 'lowpass', frequency: 200 } },
    ],
    makeBuffer(ctx, sound) {
      return makeLoop(ctx, sound.seconds, sound.fill);
    },
  };
})();
