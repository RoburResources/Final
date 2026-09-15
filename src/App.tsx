import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Mic, MicOff, ScrollText, Settings, Square, X } from 'lucide-react';
import Orb, { type OrbState } from './Orb';
import FaceGlyph from './FaceGlyph';
import { checkSupport, enrol, post, readableError, signIn } from './passkey';
import {
  Ears,
  Mouth,
  loadVoices,
  onVoicesChanged,
  recognitionSupported,
  speechSupported,
  takeSentences,
} from './voice';

type Turn = { role: 'user' | 'assistant'; text: string; at: string };
type Phase = 'boot' | 'locked' | 'ready';

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [claimed, setClaimed] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [support, setSupport] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [scan, setScan] = useState<'idle' | 'scanning' | 'ok' | 'fail'>('idle');
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');

  const [state, setState] = useState<OrbState>('locked');
  const [level, setLevel] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [caption, setCaption] = useState('');
  const [captionKind, setCaptionKind] = useState<'hint' | 'speech' | 'interim'>('hint');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [micOpen, setMicOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [sheet, setSheet] = useState<'none' | 'script' | 'settings'>('none');
  const [unread, setUnread] = useState(0);
  const [micNote, setMicNote] = useState('');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceIdx, setVoiceIdx] = useState(0);
  const [lang, setLang] = useState('en-AU');

  const ears = useRef<Ears | null>(null);
  const mouth = useRef<Mouth | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const busy = useRef(false);
  const sheetRef = useRef<'none' | 'script' | 'settings'>('none');

  turnsRef.current = turns;
  sheetRef.current = sheet;

  const hint = useCallback((t: string) => {
    setCaption(t);
    setCaptionKind('hint');
  }, []);

  /* ------------------------------ auth ------------------------------ */

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await checkSupport();
      if (!alive) return;
      setSupport(s);
      try {
        const res = await fetch('/api/state', { credentials: 'same-origin' });
        const data = await res.json();
        if (!alive) return;
        setClaimed(Boolean(data.claimed));
        setNeedsCode(Boolean(data.needsCode));
        if (data.signedIn) {
          setPhase('ready');
          setState('idle');
        } else {
          setPhase('locked');
        }
      } catch {
        if (alive) setPhase('locked');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const afterAuth = useCallback(() => {
    setClaimed(true);
    setPhase('ready');
    setState('idle');
  }, []);

  const doEnrol = async () => {
    setAuthBusy(true);
    setAuthError('');
    setScan('scanning');
    try {
      await enrol(navigator.platform || 'This device', code.trim());
      setScan('ok');
      afterAuth();
    } catch (err) {
      setScan('fail');
      const res = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setAuthError(res || readableError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const doSignIn = async () => {
    setAuthBusy(true);
    setAuthError('');
    setScan('scanning');
    try {
      await signIn();
      setScan('ok');
      afterAuth();
    } catch (err) {
      setScan('fail');
      const res = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setAuthError(res || readableError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const lock = () => {
    ears.current?.close();
    mouth.current?.stop();
    void fetch('/api/lock', { method: 'POST', credentials: 'same-origin' });
    setMicOpen(false);
    setPhase('locked');
    setState('locked');
    setSheet('none');
  };

  /* --------------------------- transcript --------------------------- */

  useEffect(() => {
    if (phase !== 'ready') return;
    fetch('/api/transcript', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => setTurns(Array.isArray(d.turns) ? d.turns : []))
      .catch(() => {});
  }, [phase]);

  const push = useCallback((turn: Turn) => {
    setTurns((prev) => [...prev, turn]);
    if (sheetRef.current !== 'script') setUnread((u) => u + 1);
  }, []);

  /* ------------------------------ voices ---------------------------- */

  useEffect(() => {
    if (!speechSupported) return;
    const refresh = () => {
      const list = loadVoices();
      setVoices(list);
      setVoiceIdx((cur) => {
        if (list[cur]) return cur;
        const au = list.findIndex((v) => /en[-_]AU/i.test(v.lang));
        if (au >= 0) return au;
        const en = list.findIndex((v) => /^en/i.test(v.lang));
        return en >= 0 ? en : 0;
      });
    };
    refresh();
    return onVoicesChanged(refresh);
  }, []);

  useEffect(() => {
    if (mouth.current) mouth.current.voice = voices[voiceIdx] || null;
  }, [voices, voiceIdx]);

  /* ---------------------------- mic level --------------------------- */

  useEffect(() => {
    if (phase !== 'ready') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicNote('This browser cannot open a microphone.');
      return;
    }
    let raf = 0;
    let ctx: AudioContext | null = null;
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.78;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          raf = requestAnimationFrame(tick);
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-7);
          setLevel(Math.max(0, Math.min(1, (db + 55) / 45)));
        };
        tick();
      })
      .catch((err: DOMException) => {
        setMicNote(
          err?.name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : err?.name === 'NotAllowedError'
              ? 'The browser blocked the microphone. Allow it in the site settings beside the address bar, then reload.'
              : `The microphone could not be opened (${err?.name || 'unknown'}).`,
        );
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ctx?.close().catch(() => {});
    };
  }, [phase]);

  /* ------------------------------ engine ---------------------------- */

  const ask = useCallback(
    async (text: string) => {
      if (busy.current) return;
      busy.current = true;

      push({ role: 'user', text, at: new Date().toISOString() });
      mouth.current?.stop();
      ears.current?.holdForSpeech(true);
      setState('thinking');
      setCaption('');

      const line = { text: '' };
      let spoken = 0;
      const speakReady = () => {
        const { spoken: chunk } = takeSentences(line.text.slice(spoken));
        if (chunk) {
          mouth.current?.say(chunk);
          spoken += chunk.length;
        }
      };

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            text,
            history: turnsRef.current.slice(-20).map((t) => ({ role: t.role, text: t.text })),
          }),
        });
        if (res.status === 401) {
          lock();
          return;
        }
        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let failed = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const payload = frame.replace(/^data: /, '').trim();
            if (!payload) continue;
            let msg: { delta?: string; done?: boolean; error?: string };
            try {
              msg = JSON.parse(payload);
            } catch {
              continue;
            }
            if (msg.error) failed = msg.error;
            if (msg.delta) {
              line.text += msg.delta;
              setCaption(line.text);
              setCaptionKind('speech');
              if (speechSupported) speakReady();
            }
          }
        }

        if (failed) {
          hint(failed);
        } else {
          const tail = line.text.slice(spoken).trim();
          if (tail && speechSupported) mouth.current?.say(tail);
          push({ role: 'assistant', text: line.text.trim(), at: new Date().toISOString() });
        }

        if (!speechSupported || failed) {
          ears.current?.holdForSpeech(false);
          setState(ears.current?.isOpen ? 'listening' : 'idle');
        }
      } catch (err) {
        hint((err as Error)?.message || 'The connection dropped. Say it again when ready.');
        ears.current?.holdForSpeech(false);
        setState(ears.current?.isOpen ? 'listening' : 'idle');
      } finally {
        busy.current = false;
      }
    },
    [hint, push],
  );

  useEffect(() => {
    if (phase !== 'ready') return;

    mouth.current = new Mouth(
      () => setState('speaking'),
      () => {
        ears.current?.holdForSpeech(false);
        setState(ears.current?.isOpen ? 'listening' : 'idle');
      },
      () => setPulse((p) => p + 1),
    );
    mouth.current.voice = voices[voiceIdx] || null;

    ears.current = new Ears({
      onOpen: () => setMicNote(''),
      onInterim: (text) => {
        setCaption(text);
        setCaptionKind('interim');
      },
      onFinal: (text) => void ask(text),
      onError: (code, fatal) => {
        if (fatal) {
          setMicOpen(false);
          setState('idle');
          setMicNote('The browser blocked the microphone. Allow it for this site, then try again.');
          setTyping(true);
        } else if (code === 'audio-capture') {
          setMicNote('No microphone input was found.');
        }
      },
    });

    return () => {
      ears.current?.close();
      mouth.current?.stop();
      ears.current = null;
      mouth.current = null;
    };
    // The engine is built once per unlocked session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const openLine = () => {
    if (!recognitionSupported) {
      setTyping(true);
      return;
    }
    setMuted(false);
    setMicOpen(true);
    setState('listening');
    hint("Go ahead — I'm listening.");
    ears.current?.setMuted(false);
    ears.current?.open();
  };

  const closeLine = () => {
    setMicOpen(false);
    setMuted(false);
    ears.current?.close();
    mouth.current?.stop();
    setState('idle');
    hint(turns.length ? 'Line closed. Start again whenever.' : 'Tap the button and start talking.');
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    ears.current?.setMuted(next);
  };

  const submitDraft = (e: React.FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    setDraft('');
    void ask(v);
  };

  const clearTranscript = async () => {
    await post('/api/transcript/clear').catch(() => {});
    setTurns([]);
  };

  /* ------------------------------ render ---------------------------- */

  if (phase === 'boot') {
    return (
      <div className="stage stage--centre">
        <FaceGlyph size={84} phase="idle" />
      </div>
    );
  }

  if (phase === 'locked') {
    return (
      <div className="stage stage--centre">
        <div className="lock">
          <FaceGlyph size={104} phase={scan} />
          <h1 className="lock__title">Talkback</h1>
          <p className="lock__sub">
            {claimed
              ? 'Your private voice line. Unlock it with Face ID.'
              : needsCode
                ? 'Your private voice line. Enter the setup code, then claim it with Face ID.'
                : 'Your private voice line. Set up Face ID to claim it — the first device to enrol keeps it.'}
          </p>

          <p className="lock__hint">
            {authBusy
              ? 'Look at your device…'
              : scan === 'fail'
                ? 'Face not recognised'
                : ''}
          </p>

          {!support.ok && <p className="notice notice--bad">{support.reason}</p>}
          {authError && <p className="notice notice--bad">{authError}</p>}

          {support.ok && !claimed && needsCode && (
            <input
              className="codefield"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Setup code"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={authBusy}
            />
          )}

          {support.ok && (
            <button
              className="btn"
              onClick={claimed ? doSignIn : doEnrol}
              disabled={authBusy || (!claimed && needsCode && !code.trim())}
              type="button"
            >
              {claimed ? 'Unlock with Face ID' : 'Set Up Face ID'}
            </button>
          )}

          {!claimed && !needsCode && (
            <p className="notice notice--warn">
              Not yet claimed. Set this up now — until you do, anyone with this link could claim it.
            </p>
          )}

          <p className="fineprint">
            Uses Face ID, Touch ID, Windows Hello or your Android screen lock. Your face is checked by
            the device itself and never leaves it — this site only ever receives a public key.
          </p>
        </div>
      </div>
    );
  }

  const stateLabel =
    muted && micOpen
      ? 'Muted'
      : state === 'listening'
        ? 'Listening'
        : state === 'thinking'
          ? 'Thinking'
          : state === 'speaking'
            ? 'Speaking'
            : 'Ready';

  return (
    <div className="stage">
      <header className="bar">
        <span className="bar__title">Talkback</span>
        <span className="spacer" />
        <button
          className="navbtn"
          type="button"
          aria-label="Transcript"
          onClick={() => {
            setSheet(sheet === 'script' ? 'none' : 'script');
            setUnread(0);
          }}
        >
          <ScrollText size={16} />
          {unread > 0 && <span className="badge">{unread}</span>}
        </button>
        <button
          className="navbtn"
          type="button"
          aria-label="Settings"
          onClick={() => setSheet(sheet === 'settings' ? 'none' : 'settings')}
        >
          <Settings size={16} />
        </button>
      </header>

      <main className="centre">
        <Orb state={state} level={muted ? 0 : level} pulse={pulse} />
        <p className="state" data-s={state} role="status" aria-live="polite">
          {stateLabel}
        </p>
        <div className="caption">
          {caption && <p className={`caption__text caption__text--${captionKind}`}>{caption}</p>}
        </div>
        {micNote && <p className="notice notice--bad notice--inline">{micNote}</p>}
      </main>

      {typing && (
        <form className="typebar" onSubmit={submitDraft}>
          <input
            id="draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type instead"
            autoComplete="off"
          />
          <button type="submit">Send</button>
        </form>
      )}

      <footer className="dock">
        <button
          className="round"
          type="button"
          aria-pressed={muted}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          onClick={toggleMute}
          disabled={!micOpen}
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        <button
          className="call"
          type="button"
          data-live={micOpen ? '1' : '0'}
          aria-label={micOpen ? 'End the line' : 'Start the line'}
          onClick={micOpen ? closeLine : openLine}
          disabled={!recognitionSupported && !micOpen}
        >
          {micOpen ? <Square size={24} /> : <Mic size={26} />}
        </button>

        <button
          className="round"
          type="button"
          aria-pressed={typing}
          aria-label="Type instead"
          onClick={() => setTyping(!typing)}
        >
          <Keyboard size={20} />
        </button>
      </footer>

      <div
        className={`scrim ${sheet !== 'none' ? 'open' : ''}`}
        onClick={() => setSheet('none')}
      />

      <aside className={`sheet ${sheet === 'script' ? 'open' : ''}`} aria-hidden={sheet !== 'script'}>
        <div className="sheet__grab" />
        <div className="sheet__head">
          <h2>Transcript</h2>
          <span className="spacer" />
          <button className="navbtn" type="button" onClick={clearTranscript}>
            Clear
          </button>
          <button className="navbtn" type="button" onClick={() => setSheet('none')} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="sheet__body">
          {turns.length === 0 ? (
            <p className="empty">Nothing said yet. Start the line and talk.</p>
          ) : (
            turns.map((t, i) => (
              <div
                className={`bubble bubble--${t.role === 'user' ? 'user' : 'claude'}`}
                key={`${t.at}-${i}`}
              >
                <p>{t.text}</p>
              </div>
            ))
          )}
        </div>
      </aside>

      <aside
        className={`sheet ${sheet === 'settings' ? 'open' : ''}`}
        aria-hidden={sheet !== 'settings'}
      >
        <div className="sheet__grab" />
        <div className="sheet__head">
          <h2>Settings</h2>
          <span className="spacer" />
          <button className="navbtn" type="button" onClick={() => setSheet('none')} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <div className="sheet__body">
          <p className="group__label">Voice</p>
          <div className="group">
            <div className="row row--stack">
              <label className="row__label" htmlFor="voice">
                Spoken replies
              </label>
              <select
                id="voice"
                value={voiceIdx}
                onChange={(e) => setVoiceIdx(Number(e.target.value))}
              >
                {voices.length === 0 && <option>System default</option>}
                {voices.map((v, i) => (
                  <option key={`${v.name}-${i}`} value={i}>
                    {v.name} · {v.lang}
                  </option>
                ))}
              </select>
            </div>
            <div className="row row--stack">
              <label className="row__label" htmlFor="lang">
                Recognition language
              </label>
              <select
                id="lang"
                value={lang}
                onChange={(e) => {
                  setLang(e.target.value);
                  ears.current?.setLang(e.target.value);
                }}
              >
                <option value="en-AU">English (Australia)</option>
                <option value="en-GB">English (UK)</option>
                <option value="en-US">English (US)</option>
              </select>
            </div>
          </div>

          <p className="group__label">Security</p>
          <div className="group">
            <div className="row">
              <span className="row__label">Face ID</span>
              <span className="row__value">On</span>
            </div>
            <button className="row btn--destructive" type="button" onClick={lock}>
              <span className="row__label">Lock this device</span>
            </button>
          </div>
          <p className="group__footnote">
            Locking signs this browser out. The passkey stays enrolled, so Face ID will let you
            straight back in.
          </p>

          <p className="group__footnote">
            Speech recognition in Chrome is cloud-based, so what you say leaves the device to be
            transcribed. The transcript is stored on this app's server and is only readable while
            signed in.
          </p>
        </div>
      </aside>
    </div>
  );
}
