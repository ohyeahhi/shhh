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

  // 쉬~ 쉬~: 부모가 입으로 길게 내는 "쉬~~~~ 쉬~~~~~~~~" 소리.
  // 한 번에 3~5초씩 길게 내고, 사이에 숨 들이쉬는 짧은 틈(약 0.5초)이 있습니다.
  // 길이를 들쭉날쭉하게 섞어 기계적으로 들리지 않게 합니다.
  const SHUSH_PATTERN = [3.0, 4.5, 3.5, 5.0, 3.0, 4.0]; // 각 회차 길이(초, 틈 포함), 합계 23초
  const SHUSH_SECONDS = SHUSH_PATTERN.reduce((a, b) => a + b, 0);

  function shush(d, rate, len) {
    white(d);
    const scale = len / (SHUSH_SECONDS * rate); // 반올림 오차 보정
    const env = new Float32Array(len);
    let pos = 0;
    SHUSH_PATTERN.forEach((sec) => {
      const total = Math.round(sec * rate * scale);
      const gap = Math.round((0.4 + Math.random() * 0.2) * rate);
      const body = total - gap;
      const attack = 0.12 * rate;
      const release = 0.35 * rate;
      const wobble = Math.random() * Math.PI * 2;
      for (let k = 0; k < total && pos + k < len; k++) {
        let e = 0;
        if (k < body) {
          const t = k / body;
          // 숨이 줄어들며 끝으로 갈수록 살짝 약해지고, 미세하게 흔들림
          e = (1 - 0.25 * t) * (1 + 0.05 * Math.sin(2 * Math.PI * 0.7 * (k / rate) + wobble));
          if (k < attack) e *= k / attack;
          if (k > body - release) e *= (body - k) / release;
        }
        env[pos + k] = e;
      }
      pos += total;
    });
    for (let i = 0; i < d.length; i++) d[i] *= env[i % len] + 0.03;
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

  // gain: 소리마다 체감 크기를 비슷하게 맞추는 보정값 (필터 후 RMS 기준 약 -21dB)
  window.Noise = {
    sounds: [
      { id: 'shush', gain: 1.1, name: '쉬~ 쉬~', emoji: '🤫', desc: '엄마 아빠가 내는 쉬~ 소리', seconds: SHUSH_SECONDS, fill: shush, filter: { type: 'bandpass', frequency: 3000, Q: 0.6 } },
      { id: 'womb', gain: 1.4, name: '엄마 뱃속', emoji: '🤰', desc: '심장 소리와 뱃속 소리', seconds: 10, fill: womb, filter: { type: 'lowpass', frequency: 600 } },
      { id: 'dryer', gain: 0.77, name: '드라이기', emoji: '💨', desc: '헤어드라이어 소리', seconds: 10, fill: dryer, filter: { type: 'lowpass', frequency: 6000 } },
      { id: 'vacuum', gain: 0.8, name: '청소기', emoji: '🧹', desc: '윙~ 하는 청소기 소리', seconds: 10, fill: vacuum, filter: { type: 'lowpass', frequency: 7000 } },
      { id: 'car', gain: 0.9, name: '자동차 안', emoji: '🚗', desc: '차만 타면 자는 아기에게', seconds: 10, fill: car, filter: { type: 'lowpass', frequency: 400 } },
      { id: 'rain', gain: 2.0, name: '빗소리', emoji: '🌧️', desc: '잔잔하게 내리는 비', seconds: 12, fill: rain, filter: { type: 'highpass', frequency: 400 } },
      { id: 'fan', gain: 0.83, name: '선풍기', emoji: '🌀', desc: '일정한 바람 소리', seconds: 10, fill: fan, filter: { type: 'lowpass', frequency: 900 } },
      { id: 'white', gain: 0.56, name: '백색소음', emoji: '☁️', desc: '쏴~ 하는 기본 소리', seconds: 6, fill: white, filter: { type: 'lowpass', frequency: 9000 } },
    ],
    makeBuffer(ctx, sound) {
      return makeLoop(ctx, sound.seconds, sound.fill);
    },
  };
})();
