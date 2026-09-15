import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Mic, MicOff, ScrollText, Settings, Square, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import Orb from '@/components/Orb';
import FaceGlyph from '@/components/FaceGlyph';
import { checkSupport, enrol, readableError, state as faceState, unlock } from '@/lib/passkey';
import {
  Ears,
  Mouth,
  loadVoices,
  onVoicesChanged,
  recognitionSupported,
  speechSupported,
  takeSentences,
} from '@/lib/voice';

export default function App() {
  const [phase, setPhase] = useState('boot'); // boot | signin | locked | ready
  const [enrolled, setEnrolled] = useState(false);
  const [email, setEmail] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [support, setSupport] = useState({ ok: true });
  const [scan, setScan] = useState('idle');

  const [orbState, setOrbState] = useState('locked');
  const [level, setLevel] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [caption, setCaption] = useState('');
  const [captionKind, setCaptionKind] = useState('hint');
  const [turns, setTurns] = useState([]);
  const [micOpen, setMicOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [sheet, setSheet] = useState('none');
  const [unread, setUnread] = useState(0);
  const [micNote, setMicNote] = useState('');
  const [voices, setVoices] = useState([]);
  const [voiceIdx, setVoiceIdx] = useState(0);
  const [lang, setLang] = useState('en-AU');

  const ears = useRef(null);
  const mouth = useRef(null);
  const turnsRef = useRef([]);
  const sheetRef = useRef('none');
  const busy = useRef(false);

  turnsRef.current = turns;
  sheetRef.current = sheet;

  const hint = useCallback((t) => {
    setCaption(t);
    setCaptionKind('hint');
  }, []);

  /* ------------------------------ boot ------------------------------ */

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await checkSupport();
      if (alive) setSupport(s);
      try {
        const me = await base44.auth.me();
        if (!alive) return;
        if (!me) {
          setPhase('signin');
          return;
        }
        setEmail(me.email || '');
        const st = await faceState();
        if (!alive) return;
        setEnrolled(Boolean(st.enrolled));
        setPhase('locked');
      } catch {
        if (alive) setPhase('signin');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const signIn = () => {
    setAuthBusy(true);
    // loginWithProvider redirects the browser; it does not resolve.
    base44.auth.loginWithProvider('google', window.location.href);
  };

  const runFaceId = async () => {
    setAuthBusy(true);
    setAuthError('');
    setScan('scanning');
    try {
      if (enrolled) await unlock();
      else await enrol(navigator.platform || 'This device');
      setScan('ok');
      setEnrolled(true);
      setPhase('ready');
      setOrbState('idle');
    } catch (err) {
      setScan('fail');
      setAuthError(readableError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const lock = () => {
    ears.current?.close();
    mouth.current?.stop();
    setMicOpen(false);
    setPhase('locked');
    setScan('idle');
    setOrbState('locked');
    setSheet('none');
  };

  /* --------------------------- transcript --------------------------- */

  useEffect(() => {
    if (phase !== 'ready') return;
    base44.functions
      .invoke('voiceChat', { action: 'history' })
      .then((res) => setTurns(Array.isArray(res.data?.turns) ? res.data.turns : []))
      .catch(() => {});
  }, [phase]);

  const push = useCallback((turn) => {
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
    let ctx = null;
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const AC = window.AudioContext || window.webkitAudioContext;
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
      .catch((err) => {
        setMicNote(
          err?.name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : err?.name === 'NotAllowedError'
              ? 'The browser blocked the microphone. Allow it in site settings beside the address bar, then reload.'
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
    async (text) => {
      if (busy.current) return;
      busy.current = true;

      push({ role: 'user', text, at: new Date().toISOString() });
      mouth.current?.stop();
      ears.current?.holdForSpeech(true);
      setOrbState('thinking');
      setCaption('');

      try {
        const res = await base44.functions.invoke('voiceChat', {
          text,
          history: turnsRef.current.slice(-20).map((t) => ({ role: t.role, text: t.text })),
        });
        const reply = String(res.data?.reply || '').trim();
        push({ role: 'assistant', text: reply, at: new Date().toISOString() });
        setCaption(reply);
        setCaptionKind('speech');

        if (speechSupported && mouth.current) {
          const { spoken, rest } = takeSentences(reply);
          if (spoken) mouth.current.say(spoken);
          if (rest.trim()) mouth.current.say(rest);
        } else {
          ears.current?.holdForSpeech(false);
          setOrbState(ears.current?.isOpen ? 'listening' : 'idle');
        }
      } catch (err) {
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          lock();
        } else {
          hint(err?.response?.data?.error || 'The connection dropped. Say it again when ready.');
          ears.current?.holdForSpeech(false);
          setOrbState(ears.current?.isOpen ? 'listening' : 'idle');
        }
      } finally {
        busy.current = false;
      }
    },
    [hint, push],
  );

  useEffect(() => {
    if (phase !== 'ready') return;

    mouth.current = new Mouth(
      () => setOrbState('speaking'),
      () => {
        ears.current?.holdForSpeech(false);
        setOrbState(ears.current?.isOpen ? 'listening' : 'idle');
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
          setOrbState('idle');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const openLine = () => {
    if (!recognitionSupported) {
      setTyping(true);
      return;
    }
    setMuted(false);
    setMicOpen(true);
    setOrbState('listening');
    hint("Go ahead — I'm listening.");
    ears.current?.setMuted(false);
    ears.current?.open();
  };

  const closeLine = () => {
    setMicOpen(false);
    setMuted(false);
    ears.current?.close();
    mouth.current?.stop();
    setOrbState('idle');
    hint(turns.length ? 'Line closed. Start again whenever.' : 'Tap the button and start talking.');
  };

  const clearTranscript = async () => {
    await base44.functions.invoke('voiceChat', { action: 'clear' }).catch(() => {});
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

  if (phase === 'signin' || phase === 'locked') {
    const needsSignIn = phase === 'signin';
    return (
      <div className="stage stage--centre">
        <div className="lock">
          <FaceGlyph size={104} phase={needsSignIn ? 'idle' : scan} />
          <h1 className="lock__title">Talkback</h1>
          <p className="lock__sub">
            {needsSignIn
              ? 'Your private voice line. Sign in to continue.'
              : enrolled
                ? `Unlock with Face ID to open the line.`
                : 'Set up Face ID on this device to open the line.'}
          </p>

          <p className="lock__hint">
            {authBusy && !needsSignIn
              ? 'Look at your device…'
              : scan === 'fail'
                ? 'Not recognised'
                : email && !needsSignIn
                  ? email
                  : ''}
          </p>

          {!support.ok && !needsSignIn && <p className="notice notice--bad">{support.reason}</p>}
          {authError && <p className="notice notice--bad">{authError}</p>}

          {needsSignIn ? (
            <button className="btn" type="button" onClick={signIn} disabled={authBusy}>
              Sign In
            </button>
          ) : (
            support.ok && (
              <button className="btn" type="button" onClick={runFaceId} disabled={authBusy}>
                {enrolled ? 'Unlock with Face ID' : 'Set Up Face ID'}
              </button>
            )
          )}

          <p className="fineprint">
            Uses Face ID, Touch ID, Windows Hello or your Android screen lock. Your face is checked
            by the device itself and never leaves it — this site only ever receives a public key.
          </p>
        </div>
      </div>
    );
  }

  const stateLabel =
    muted && micOpen
      ? 'Muted'
      : orbState === 'listening'
        ? 'Listening'
        : orbState === 'thinking'
          ? 'Thinking'
          : orbState === 'speaking'
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
          <ScrollText size={17} />
          {unread > 0 && <span className="badge">{unread}</span>}
        </button>
        <button
          className="navbtn"
          type="button"
          aria-label="Settings"
          onClick={() => setSheet(sheet === 'settings' ? 'none' : 'settings')}
        >
          <Settings size={17} />
        </button>
      </header>

      <main className="centre">
        <Orb state={orbState} level={muted ? 0 : level} pulse={pulse} />
        <p className="state" data-s={orbState} role="status" aria-live="polite">
          {stateLabel}
        </p>
        <div className="caption">
          {caption && <p className={`caption__text caption__text--${captionKind}`}>{caption}</p>}
        </div>
        {micNote && <p className="notice notice--bad notice--inline">{micNote}</p>}
      </main>

      {typing && (
        <form
          className="typebar"
          onSubmit={(e) => {
            e.preventDefault();
            const v = draft.trim();
            if (!v) return;
            setDraft('');
            void ask(v);
          }}
        >
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
          disabled={!micOpen}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            ears.current?.setMuted(next);
          }}
        >
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>

        <button
          className="call"
          type="button"
          data-live={micOpen ? '1' : '0'}
          aria-label={micOpen ? 'End the line' : 'Start the line'}
          onClick={micOpen ? closeLine : openLine}
          disabled={!recognitionSupported && !micOpen}
        >
          {micOpen ? <Square size={26} /> : <Mic size={28} />}
        </button>

        <button
          className="round"
          type="button"
          aria-pressed={typing}
          aria-label="Type instead"
          onClick={() => setTyping(!typing)}
        >
          <Keyboard size={22} />
        </button>
      </footer>

      <div className={`scrim ${sheet !== 'none' ? 'open' : ''}`} onClick={() => setSheet('none')} />

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
              <span className="row__label">Signed in</span>
              <span className="row__value">{email}</span>
            </div>
            <div className="row">
              <span className="row__label">Face ID</span>
              <span className="row__value">{enrolled ? 'On' : 'Off'}</span>
            </div>
            <button className="row btn--destructive" type="button" onClick={lock}>
              <span className="row__label">Lock</span>
            </button>
          </div>
          <p className="group__footnote">
            Locking closes the line and asks for Face ID again. Your passkey stays enrolled.
          </p>

          <p className="group__footnote">
            Speech recognition in Chrome is cloud-based, so what you say leaves the device to be
            transcribed. The transcript is stored against your account and is readable only by you.
          </p>
        </div>
      </aside>
    </div>
  );
}
