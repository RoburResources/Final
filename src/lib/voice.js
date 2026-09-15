/**
 * Speech in and out.
 *
 * Replies are spoken sentence by sentence as they arrive rather than after the
 * whole answer lands — that is the difference between a live line and a
 * walkie-talkie. Half duplex is the default: the microphone closes while
 * Claude speaks so the synthesiser is never transcribed as input.
 */

// Typed loosely on purpose: SpeechRecognition is not in every TS DOM lib.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const recognitionSupported = Boolean(SR);

export class Ears {
  constructor(listener) {
    this.l = listener;
    this.rec = null;
    this.running = false;
    this.want = false;
    this.muted = false;
    this.lang = 'en-AU';
    this.blockedBySpeech = false;
  }

  setLang(lang) {
    this.lang = lang;
    if (this.rec) {
      this.stop_();
      this.rec = null;
      if (this.want) setTimeout(() => this.start_(), 200);
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted) this.stop_();
    else this.start_();
  }

  /** Half duplex: hold the mic closed while we are talking. */
  holdForSpeech(holding) {
    this.blockedBySpeech = holding;
    if (holding) this.stop_();
    else if (this.want) this.start_();
  }

  open() {
    this.want = true;
    this.start_();
  }

  close() {
    this.want = false;
    this.stop_();
  }

  get isOpen() {
    return this.want;
  }

  build() {
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = this.lang;

    r.onstart = () => {
      this.running = true;
      this.l.onOpen();
    };

    r.onresult = (ev) => {
      if (this.muted) return;
      let interim = '';
      let final = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (interim) this.l.onInterim(interim);
      if (final.trim()) this.l.onFinal(final.trim());
    };

    r.onerror = (ev) => {
      const code = ev?.error || 'unknown';
      const fatal = code === 'not-allowed' || code === 'service-not-allowed';
      if (fatal) this.want = false;
      if (code !== 'no-speech' && code !== 'aborted') this.l.onError(code, fatal);
    };

    r.onend = () => {
      this.running = false;
      // Chrome ends the stream by itself; reopen while the line is meant to be open.
      if (this.want && !this.muted && !this.blockedBySpeech) setTimeout(() => this.start_(), 220);
    };

    return r;
  }

  start_() {
    if (!SR || this.running || !this.want || this.muted || this.blockedBySpeech) return;
    if (!this.rec) this.rec = this.build();
    try {
      this.rec.lang = this.lang;
      this.rec.start();
    } catch {
      /* already started */
    }
  }

  stop_() {
    if (this.rec && this.running) {
      try {
        this.rec.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

/* -------------------------------- speech out ------------------------------- */

const synth = window.speechSynthesis || null;
export const speechSupported = Boolean(synth);

export function loadVoices() {
  if (!synth) return [];
  return synth.getVoices() || [];
}

export function onVoicesChanged(fn) {
  if (!synth) return () => {};
  synth.addEventListener('voiceschanged', fn);
  return () => synth.removeEventListener('voiceschanged', fn);
}

export class Mouth {
  constructor(onStart, onIdle, onWord) {
    this.onStart = onStart;
    this.onIdle = onIdle;
    this.onWord = onWord;
    this.queue = [];
    this.speaking = false;
    this.voice = null;
  }

  say(text) {
    const clean = text.trim();
    if (!synth || !clean) return;
    this.queue.push(clean);
    this.drain();
  }

  drain() {
    if (!synth || this.speaking) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.onIdle();
      return;
    }
    this.speaking = true;
    this.onStart();

    const u = new SpeechSynthesisUtterance(next);
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    }
    u.rate = 1.04;
    u.onboundary = () => this.onWord();
    u.onend = () => {
      this.speaking = false;
      this.drain();
    };
    u.onerror = () => {
      this.speaking = false;
      this.drain();
    };
    try {
      synth.speak(u);
    } catch {
      this.speaking = false;
    }
  }

  stop() {
    this.queue.length = 0;
    if (synth) {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    }
    this.speaking = false;
  }

  get isSpeaking() {
    return this.speaking || this.queue.length > 0;
  }
}

/** Split off whole sentences so speech can start before the answer finishes. */
export function takeSentences(buffer) {
  const re = /[^.!?…]+[.!?…]+["')\]]*\s*/g;
  let last = 0;
  let m;
  while ((m = re.exec(buffer)) !== null) last = m.index + m[0].length;
  return last > 0
    ? { spoken: buffer.slice(0, last), rest: buffer.slice(last) }
    : { spoken: '', rest: buffer };
}
