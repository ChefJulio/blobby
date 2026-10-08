import { useState, useCallback, useRef, useEffect } from 'react';
import { motion, MotionConfig } from 'motion/react';
import {
  ArrowRight, AudioLines, ChevronDown, ChevronUp, CircleHelp, FileAudio,
  Link2, Maximize, Mic, Pause, Play, Repeat, Square, Upload,
} from 'lucide-react';
import Blobby from './Blobby';
import AutoHeight from './AutoHeight';
import './App.css';

const EASE_OUT = [0.2, 0, 0, 1];

// Player card states. 'idle' fades the controls while music plays and nobody
// is interacting; 'hidden' is the explicit hide / fullscreen state. The card
// stays mounted in every state so embeds keep playing.
const CARD_VARIANTS = {
  shown: { opacity: 1, y: 0, visibility: 'visible', pointerEvents: 'auto', transition: { duration: 0.3, ease: EASE_OUT } },
  idle: { opacity: 0, y: 6, pointerEvents: 'none', transition: { duration: 0.8, ease: 'easeInOut' } },
  hidden: {
    opacity: 0, y: 24, pointerEvents: 'none',
    transition: { duration: 0.25, ease: EASE_OUT },
    transitionEnd: { visibility: 'hidden' },
  },
};

const PILL_TRANSITION = { type: 'spring', stiffness: 500, damping: 38 };

// Touch-first devices: skip autofocus (it pops the keyboard) and read links
// from the clipboard instead
const IS_TOUCH = window.matchMedia?.('(pointer: coarse)').matches ?? false;

const IDLE_MS = 3000;
const FULLSCREEN_IDLE_MS = 1200;
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'];

// Segmented-control button; the active one hosts the shared pill, which
// Motion slides between buttons via layoutId
function SegItem({ active, icon, label, onClick }) {
  return (
    <button className={`seg-item${active ? ' active' : ''}`} aria-pressed={active} onClick={onClick}>
      {active && <motion.span layoutId="seg-pill" className="seg-pill" transition={PILL_TRANSITION} />}
      {icon}
      <span>{label}</span>
    </button>
  );
}

const ACCEPT_MEDIA = 'audio/*,video/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.wma,.opus,.webm,.mp4,.mov';

function parseLinkTarget(str) {
  const videoId = (str.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/) || [])[1] || null;
  let listId = (str.match(/[?&]list=([\w-]+)/) || [])[1] || null;
  // Mixes (RD*) and private lists (WL/LL) don't work in embeds - drop them
  // and fall back to the single video if there is one
  if (listId && /^(RD|WL|LL)/.test(listId)) listId = null;
  if (videoId || listId) return { service: 'youtube', videoId, listId };

  const sp = str.match(/open\.spotify\.com\/(?:intl-[\w-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/);
  if (sp) {
    return {
      service: 'spotify',
      pageUrl: `https://open.spotify.com/${sp[1]}/${sp[2]}`,
      embedUrl: `https://open.spotify.com/embed/${sp[1]}/${sp[2]}`,
    };
  }

  // Needs user/track (or user/sets/playlist) - a bare profile isn't playable
  const sc = str.match(/https?:\/\/(?:www\.)?soundcloud\.com\/[\w-]+\/(?:sets\/)?[\w-]+/);
  if (sc) {
    return {
      service: 'soundcloud',
      pageUrl: sc[0],
      // visual=true renders over the track artwork with a dark overlay -
      // the classic widget is white-only and clashes with the theme
      embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(sc[0])}&auto_play=true&visual=true&show_teaser=false`,
    };
  }

  return null;
}

// Tab audio capture via getDisplayMedia only works on desktop Chromium.
// userAgentData exists only in Chromium; mobile Chromium lacks getDisplayMedia.
const SUPPORTS_TAB_CAPTURE =
  typeof navigator.mediaDevices?.getDisplayMedia === 'function' && !!navigator.userAgentData;

// YouTube IFrame Player API loader (needed to detect embed-disabled videos)
let ytApiPromise = null;
function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });
  return ytApiPromise;
}

// SoundCloud Widget API loader (needed for looping)
let scApiPromise = null;
function loadSoundCloudApi() {
  if (scApiPromise) return scApiPromise;
  scApiPromise = new Promise((resolve) => {
    if (window.SC?.Widget) { resolve(window.SC); return; }
    const script = document.createElement('script');
    script.src = 'https://w.soundcloud.com/player/api.js';
    script.onload = () => resolve(window.SC);
    document.head.appendChild(script);
  });
  return scApiPromise;
}

const YT_EMBED_BLOCKED_MSG =
  'This video does not allow embedding. Open it on YouTube in another tab, then Capture Tab Audio and pick that tab.';

function App() {
  const [audioSource, setAudioSource] = useState(null);
  const [mode, setMode] = useState(null); // null | 'mic' | 'file' | 'link'
  const [fileName, setFileName] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubPos, setScrubPos] = useState(0);
  const [hasVideo, setHasVideo] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsDegraded, setFsDegraded] = useState(false);
  const [idle, setIdle] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const cardRef = useRef(null);
  const fileInputRef = useRef(null);
  // Link mode (YouTube / Spotify / SoundCloud embeds + tab capture)
  const [linkService, setLinkService] = useState(null); // 'youtube' | 'spotify' | 'soundcloud'
  const [webEmbedUrl, setWebEmbedUrl] = useState(null); // spotify/soundcloud iframe src
  const [ytVideoId, setYtVideoId] = useState(null);
  const [ytListId, setYtListId] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [showYtPopover, setShowYtPopover] = useState(false);
  const [showYtLanding, setShowYtLanding] = useState(false);
  const [playerHidden, setPlayerHidden] = useState(false);
  const [ytLinkInput, setYtLinkInput] = useState('');
  const [ytNotice, setYtNotice] = useState('');
  const [ytError, setYtError] = useState('');
  const [ytLoop, setYtLoop] = useState(false);
  const ytLoopRef = useRef(false); // read inside player callbacks
  const captureStreamRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytPlayerBoxRef = useRef(null);
  const scIframeRef = useRef(null);
  const audioCtxRef = useRef(null);
  const audioElRef = useRef(null);
  const micStreamRef = useRef(null);
  const rafRef = useRef(null);
  const seekBarRef = useRef(null);
  const scrubPosRef = useRef(0);
  const videoContainerRef = useRef(null);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (captureStreamRef.current) { captureStreamRef.current.getTracks().forEach(t => t.stop()); captureStreamRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    if (videoContainerRef.current) videoContainerRef.current.innerHTML = '';
    setAudioSource(null);
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
    setHasVideo(false);
    setYtVideoId(null);
    setYtListId(null);
    setLinkService(null);
    setWebEmbedUrl(null);
    setCapturing(false);
    setCaptureError('');
    setYtError('');
    setShowHelp(false);
  }, []);

  const setupAnalysers = useCallback((ctx, source, isMono, monitor = true) => {
    const splitter = ctx.createChannelSplitter(2);
    source.connect(splitter);
    if (monitor) source.connect(ctx.destination);

    const analyserMixed = ctx.createAnalyser();
    analyserMixed.fftSize = 2048;
    analyserMixed.smoothingTimeConstant = 0.8;
    source.connect(analyserMixed);

    const analyserL = ctx.createAnalyser();
    analyserL.fftSize = 2048;
    analyserL.smoothingTimeConstant = 0.8;
    splitter.connect(analyserL, 0);

    const analyserR = ctx.createAnalyser();
    analyserR.fftSize = 2048;
    analyserR.smoothingTimeConstant = 0.8;
    splitter.connect(analyserR, isMono ? 0 : 1);

    setAudioSource({ analyserL, analyserR, analyserMixed, isMono });
  }, []);

  const startMicStream = useCallback(async () => {
    // Voice-call processing (echo cancellation, noise suppression, AGC)
    // strips exactly the music we want to visualize - especially when the
    // sound comes from this device's own speakers
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    micStreamRef.current = stream;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    // Treat mic as mono: phone mics often deliver imbalanced or single-channel
    // stereo, which made the blob lopsided. The mono path renders the mixed
    // signal symmetrically on both halves.
    setupAnalysers(ctx, source, true, false);
  }, [setupAnalysers]);

  const startMic = useCallback(async () => {
    cleanup();
    try {
      await startMicStream();
      setMode('mic');
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [startMicStream, cleanup]);

  const startProgressLoop = useCallback(() => {
    function tick() {
      const audio = audioElRef.current;
      if (audio) {
        setProgress(audio.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    cleanup();
    setFileName(file.name);

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const media = document.createElement('video');
    media.crossOrigin = 'anonymous';
    media.playsInline = true;
    media.src = URL.createObjectURL(file);
    audioElRef.current = media;

    if (videoContainerRef.current) {
      videoContainerRef.current.innerHTML = '';
      videoContainerRef.current.appendChild(media);
    }

    media.addEventListener('loadedmetadata', () => {
      setDuration(media.duration);
      setHasVideo(media.videoWidth > 0 && media.videoHeight > 0);
    });
    media.addEventListener('ended', () => setIsPlaying(false));
    media.addEventListener('play', () => setIsPlaying(true));
    media.addEventListener('pause', () => setIsPlaying(false));

    const source = ctx.createMediaElementSource(media);
    setupAnalysers(ctx, source, false);
    media.play();
    setIsPlaying(true);
    setMode('file');
    startProgressLoop();
  }, [setupAnalysers, cleanup, startProgressLoop]);

  // --- YouTube audio (tab capture, or mic fallback where capture is unsupported) ---
  const stopYtAudio = useCallback(() => {
    let hadStream = false;
    if (captureStreamRef.current) {
      captureStreamRef.current.getTracks().forEach(t => t.stop());
      captureStreamRef.current = null;
      hadStream = true;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      hadStream = true;
    }
    if (!hadStream) return;
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    setAudioSource(null);
    setCapturing(false);
  }, []);

  const startMicListen = useCallback(async () => {
    setCaptureError('');
    try {
      await startMicStream();
      setCapturing(true);
    } catch (err) {
      console.error('Mic access denied:', err);
      setCaptureError('Blobby needs microphone access - allow it and try again');
    }
  }, [startMicStream]);

  const startTabCapture = useCallback(async (pickAnyTab = false) => {
    setCaptureError('');
    try {
      // Default: one-step dialog offering only this tab (preferCurrentTab).
      // pickAnyTab: full picker so any tab, window, or screen can be the
      // audio source; selfBrowserSurface makes this tab choosable there too.
      // audio:true would route capture through Chrome's echo-cancellation
      // pipeline, which downmixes to MONO - disable processing and ask for
      // both channels so the blob gets true stereo.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
        ...(pickAnyTab ? { selfBrowserSurface: 'include' } : { preferCurrentTab: true }),
      });
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(t => t.stop());
        setCaptureError('Blobby got no sound - try again and switch on "Also share tab audio"');
        return;
      }
      // Only the audio track is needed; drop video to save decoding work
      stream.getVideoTracks().forEach(t => t.stop());
      captureStreamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      setupAnalysers(ctx, source, false, false);
      setCapturing(true);
      // Fires when the user clicks the browser's "Stop sharing" bar
      audioTracks[0].addEventListener('ended', stopYtAudio);
    } catch (err) {
      // User dismissed the picker - not an error worth surfacing
      console.warn('Tab capture cancelled:', err);
    }
  }, [setupAnalysers, stopYtAudio]);

  const playLink = useCallback((target) => {
    // Keep an active capture alive across link switches - it captures the
    // whole tab, so a new target needs no new share dialog
    if (mode !== 'link') cleanup();
    setMode('link');
    setLinkService(target.service);
    setYtLinkInput('');
    setShowYtPopover(false);
    setShowHelp(false);
    setYtNotice('');
    setYtError('');
    if (target.service === 'youtube') {
      setWebEmbedUrl(null);
      setYtVideoId(target.videoId);
      setYtListId(target.listId);
      setFileName(target.videoId ? 'youtube.com/watch?v=' + target.videoId : 'YouTube playlist');
    } else {
      setYtVideoId(null);
      setYtListId(null);
      setWebEmbedUrl(target.embedUrl);
      setFileName(target.pageUrl.replace(/^https?:\/\//, ''));
      // Title lookup is best-effort; both oEmbed endpoints are keyless
      const oembedUrl = target.service === 'spotify'
        ? `https://open.spotify.com/oembed?url=${encodeURIComponent(target.pageUrl)}`
        : `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(target.pageUrl)}`;
      fetch(oembedUrl)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (d?.title) setFileName(d.title); })
        .catch(() => {});
    }
  }, [mode, cleanup]);

  // SoundCloud loop: the widget fires FINISH per track; restart the track
  // (or jump back to the first sound of a set) when loop is on
  useEffect(() => {
    if (linkService !== 'soundcloud' || !webEmbedUrl) return;
    let widget = null;
    let cancelled = false;
    loadSoundCloudApi().then((SC) => {
      if (cancelled || !SC?.Widget || !scIframeRef.current) return;
      widget = SC.Widget(scIframeRef.current);
      widget.bind(SC.Widget.Events.FINISH, () => {
        if (!ytLoopRef.current) return;
        widget.getSounds((sounds) => {
          if (!sounds || sounds.length <= 1) {
            widget.seekTo(0);
            widget.play();
          } else {
            widget.getCurrentSoundIndex((idx) => {
              if (idx >= sounds.length - 1) widget.skip(0);
            });
          }
        });
      });
    });
    return () => {
      cancelled = true;
      if (widget) { try { widget.unbind(window.SC.Widget.Events.FINISH); } catch { /* iframe gone */ } }
    };
  }, [linkService, webEmbedUrl]);

  const toggleYtLoop = useCallback(() => {
    const next = !ytLoopRef.current;
    ytLoopRef.current = next;
    setYtLoop(next);
    try { ytPlayerRef.current?.setLoop(next); } catch { /* player not ready */ }
  }, []);

  // (Re)create the IFrame API player for the current video/playlist. The
  // wrapper is keyed on the target, so each change mounts a fresh box div.
  useEffect(() => {
    if (ytPlayerRef.current) {
      try { ytPlayerRef.current.destroy(); } catch { /* DOM already gone */ }
      ytPlayerRef.current = null;
    }
    if (!ytVideoId && !ytListId) return;
    let cancelled = false;
    loadYouTubeApi().then((YT) => {
      if (cancelled || !ytPlayerBoxRef.current) return;
      ytPlayerRef.current = new YT.Player(ytPlayerBoxRef.current, {
        ...(ytVideoId ? { videoId: ytVideoId } : {}),
        width: 320,
        height: 180,
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          ...(ytListId ? { listType: 'playlist', list: ytListId } : {}),
        },
        events: {
          onReady: (e) => {
            // Playlist looping is native; re-apply the preference per player
            if (ytLoopRef.current) e.target.setLoop(true);
          },
          onStateChange: (e) => {
            // Keep the label current as playlists auto-advance
            if (e.data === 1) {
              setYtError(''); // playlists skip past unplayable entries
              const d = e.target.getVideoData?.();
              if (d?.title) setFileName(d.author ? `${d.author} - ${d.title}` : d.title);
            }
            // Single videos have no native loop - replay on end
            if (e.data === 0 && ytLoopRef.current && !ytListId) {
              e.target.seekTo(0);
              e.target.playVideo();
            }
          },
          onError: (e) => {
            if (e.data === 101 || e.data === 150) setYtError(YT_EMBED_BLOCKED_MSG);
            else if (e.data === 100) setYtError('Video not found or private.');
            else setYtError('This video cannot be played here.');
          },
        },
      });
    });
    return () => { cancelled = true; };
  }, [ytVideoId, ytListId]);

  const togglePlay = useCallback(() => {
    const audio = audioElRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
      audio.play();
    } else {
      audio.pause();
    }
  }, []);

  // --- Seek bar scrubbing ---
  const getScrubFraction = useCallback((clientX) => {
    const bar = seekBarRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handleScrubStart = useCallback((clientX) => {
    if (!duration) return;
    setScrubbing(true);
    const pos = getScrubFraction(clientX) * duration;
    scrubPosRef.current = pos;
    setScrubPos(pos);
  }, [duration, getScrubFraction]);

  const handleScrubMove = useCallback((clientX) => {
    if (!duration) return;
    const pos = getScrubFraction(clientX) * duration;
    scrubPosRef.current = pos;
    setScrubPos(pos);
  }, [duration, getScrubFraction]);

  const handleScrubEnd = useCallback(() => {
    const audio = audioElRef.current;
    if (audio && duration) {
      audio.currentTime = scrubPosRef.current;
      setProgress(scrubPosRef.current);
    }
    setScrubbing(false);
  }, [duration]);

  const onSeekMouseDown = useCallback((e) => {
    e.preventDefault();
    handleScrubStart(e.clientX);
  }, [handleScrubStart]);

  const onSeekTouchStart = useCallback((e) => {
    handleScrubStart(e.touches[0].clientX);
  }, [handleScrubStart]);

  useEffect(() => {
    if (!scrubbing) return;

    const onMouseMove = (e) => handleScrubMove(e.clientX);
    const onMouseUp = () => handleScrubEnd();
    const onTouchMove = (e) => {
      e.preventDefault();
      handleScrubMove(e.touches[0].clientX);
    };
    const onTouchEnd = () => handleScrubEnd();

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [scrubbing, handleScrubMove, handleScrubEnd]);

  // --- Drag and drop ---
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);

  const handleFileInput = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // The file <video> element is created before the player card renders (e.g.
  // from the landing screen), so attach it to the card's media box once both
  // exist. Runs when hasVideo flips true after metadata loads.
  useEffect(() => {
    const el = audioElRef.current;
    const box = videoContainerRef.current;
    if (mode === 'file' && hasVideo && el && box && el.parentNode !== box) {
      box.appendChild(el);
    }
  }, [mode, hasVideo]);

  const formatTime = (s) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  useEffect(() => {
    const onChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs) setFsDegraded(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // While a tab is being shared, Chromium keeps the browser toolbar visible in
  // fullscreen (anti-phishing). Detect that "degraded" fullscreen by checking
  // whether the viewport actually reached screen height.
  useEffect(() => {
    if (!isFullscreen) return;
    const check = () => setFsDegraded(window.innerHeight < screen.height - 40);
    const timer = setTimeout(check, 400); // let the fullscreen transition settle
    window.addEventListener('resize', check);
    return () => { clearTimeout(timer); window.removeEventListener('resize', check); };
  }, [isFullscreen]);

  // Mirror the visual viewport into CSS vars (see .app in App.css) so a
  // mobile keyboard lifts the card above it instead of panning the page.
  // Skipped while pinch-zoomed - that shrinks the visual viewport too.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const style = document.documentElement.style;
    const update = () => {
      if (Math.abs(vv.scale - 1) > 0.01) {
        style.removeProperty('--vv-h');
        style.removeProperty('--vv-top');
        return;
      }
      style.setProperty('--vv-h', `${vv.height}px`);
      style.setProperty('--vv-top', `${vv.offsetTop}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // Idle: fade the controls and cursor out while Blobby is dancing and nobody
  // is interacting. Any pointer, key or wheel input brings them back. Never
  // idles while the user is mid-task (typing a link, reading help, an error).
  const audioLive = !!audioSource && (mode !== 'file' || isPlaying);
  const canIdle = isFullscreen
    || (audioLive && !scrubbing && !showYtPopover && !showHelp && !captureError);
  const controlsIdle = idle && canIdle;

  useEffect(() => {
    if (!canIdle) return;
    const delay = isFullscreen ? FULLSCREEN_IDLE_MS : IDLE_MS;
    const hoverCapable = window.matchMedia('(hover: hover)').matches;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // A mouse resting on the card keeps it awake - checked via :hover
        // because events over an embed iframe never reach this window
        if (hoverCapable && cardRef.current?.matches(':hover')) arm();
        else setIdle(true);
      }, delay);
    };
    const wake = () => { setIdle(false); arm(); };
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, wake, { passive: true }));
    arm();
    return () => {
      clearTimeout(timer);
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, wake));
      setIdle(false);
    };
  }, [canIdle, isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }, []);

  const displayProgress = scrubbing ? scrubPos : progress;
  const seekPercent = duration ? `${(displayProgress / duration) * 100}%` : '0%';

  // Touch devices: try the clipboard first so the keyboard never has to
  // open; fall back to showing the text field. `open` reveals the field.
  const openLinkEntry = async (open) => {
    if (IS_TOUCH && navigator.clipboard?.readText) {
      try {
        const target = parseLinkTarget(await navigator.clipboard.readText());
        if (target) { playLink(target); return; }
        setYtNotice('No link on your clipboard - paste one here');
      } catch { /* clipboard denied or dismissed - use the field */ }
    }
    open();
  };

  const submitLink = (e) => {
    e.preventDefault();
    const target = parseLinkTarget(ytLinkInput);
    if (target) playLink(target);
    else setYtNotice('Not a YouTube, Spotify, or SoundCloud link');
  };

  const linkUI = (
    <form className="link-form" onSubmit={submitLink}>
      <div className="link-field">
        <Link2 className="link-field-icon" size={16} aria-hidden="true" />
        <input
          className="link-input"
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          aria-label="Song or video link"
          placeholder="YouTube, Spotify or SoundCloud link"
          value={ytLinkInput}
          onChange={(e) => { setYtLinkInput(e.target.value); setYtNotice(''); }}
          autoFocus={!IS_TOUCH}
        />
        {ytLinkInput && (
          <button className="link-submit" type="submit" aria-label="Play link">
            <ArrowRight size={16} />
          </button>
        )}
      </div>
      {ytNotice
        ? <div className="link-error" role="alert">{ytNotice}</div>
        : <div className="link-hint">Songs, albums and playlists all work</div>}
    </form>
  );

  // Capture guidance for link mode: one primary action and one essential
  // hint up front; secondary options sit behind "More help"
  const blockedCapture = ytError && SUPPORTS_TAB_CAPTURE;
  const helpItems = [
    SUPPORTS_TAB_CAPTURE && !ytError && (
      <button key="tab" className="btn-link" onClick={() => startTabCapture(true)}>
        Capture a different tab instead
      </button>
    ),
    linkService === 'spotify' && (
      <div key="spotify" className="player-hint">
        Full songs need a logged-in Spotify Premium account - otherwise 30-second previews.
      </div>
    ),
  ].filter(Boolean);

  const linkControls = capturing ? (
    <div className="live-status">
      <span className="live-dot" />
      {SUPPORTS_TAB_CAPTURE ? 'Capturing tab audio' : 'Listening'}
      <button className="btn-ghost" onClick={stopYtAudio}>
        <Square size={10} fill="currentColor" /> Stop
      </button>
    </div>
  ) : (
    <>
      <button
        className="btn-primary"
        onClick={blockedCapture ? () => startTabCapture(true)
          : SUPPORTS_TAB_CAPTURE ? () => startTabCapture(false)
          : startMicListen}
      >
        <AudioLines size={16} />
        {blockedCapture ? 'Capture That Tab' : 'Let Blobby Listen'}
      </button>
      <div className="player-hint">
        {blockedCapture ? (
          <>Open the video on YouTube in another tab, press play, then pick that tab and
            switch on <em>Also share tab audio</em>.</>
        ) : SUPPORTS_TAB_CAPTURE ? (
          <>Switch on <em>Also share tab audio</em>, then click <em>Allow</em>.</>
        ) : ytError ? (
          'Play it in the YouTube app out loud - Blobby listens through your mic.'
        ) : (
          'Turn your volume up - Blobby listens through your mic.'
        )}
      </div>
      {captureError && <div className="capture-error" role="alert">{captureError}</div>}
      {helpItems.length > 0 && (
        <>
          <div className="help-row">
            <button className="btn-ghost" aria-expanded={showHelp} onClick={() => setShowHelp(v => !v)}>
              <CircleHelp size={14} /> More help
            </button>
          </div>
          {showHelp && <div className="help-body">{helpItems}</div>}
        </>
      )}
    </>
  );

  const view = mode || 'landing';
  const activeTab = showYtPopover ? 'link' : mode;
  const cardState = isFullscreen || playerHidden ? 'hidden' : controlsIdle ? 'idle' : 'shown';

  return (
    <MotionConfig reducedMotion="user">
    <div
      className={`app${controlsIdle ? ' idle' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`blobby-container${isFullscreen ? ' fullscreen' : ''}`}
        onClick={isFullscreen ? () => document.exitFullscreen() : undefined}
      >
        <Blobby audioSource={audioSource} />
      </div>

      {isFullscreen && fsDegraded && (
        <div className="fs-notice">
          Your browser keeps its toolbar visible while a tab is being shared.
          Stop sharing to get true fullscreen.
        </div>
      )}

      {!isFullscreen && dragOver && (
        <div className="drag-overlay">
          <div className="drag-label"><Upload size={22} /> Drop a song to play it</div>
        </div>
      )}

      {playerHidden && !isFullscreen && (
        <motion.button
          className="player-show-btn"
          initial={{ opacity: 0, y: 8 }}
          animate={controlsIdle ? { opacity: 0 } : { opacity: 1, y: 0 }}
          transition={{ duration: controlsIdle ? 0.8 : 0.25 }}
          onClick={() => setPlayerHidden(false)}
          aria-label="Show controls"
          title="Show controls"
        >
          <ChevronUp size={16} />
        </motion.button>
      )}

      {/* Player card: all controls and the media preview live here. Kept
          mounted in every state so playback continues - the embeds would
          stop if unmounted. */}
      <motion.div
        ref={cardRef}
        className="player-card"
        initial={false}
        animate={cardState}
        variants={CARD_VARIANTS}
        aria-hidden={cardState === 'hidden' || undefined}
      >
        <AutoHeight>
          {/* Keyed on the view so each mode's content fades in fresh */}
          <motion.div
            key={view}
            className="card-body"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
          >
            {view === 'landing' && (
              <div className="card-landing">
                <h1 className="wordmark">Blobby</h1>
                <p className="tagline">Blobby likes to dance</p>
                <div className="source-cards">
                  <button
                    className={`source-card${showYtLanding ? ' selected' : ''}`}
                    aria-expanded={showYtLanding}
                    onClick={() => (showYtLanding
                      ? setShowYtLanding(false)
                      : openLinkEntry(() => setShowYtLanding(true)))}
                  >
                    <span className="source-icon"><Link2 size={18} /></span>
                    <span className="source-text">
                      <span className="source-title">Paste a link</span>
                      <span className="source-desc">YouTube, Spotify, SoundCloud</span>
                    </span>
                  </button>
                  <button className="source-card" onClick={startMic}>
                    <span className="source-icon"><Mic size={18} /></span>
                    <span className="source-text">
                      <span className="source-title">Microphone</span>
                      <span className="source-desc">Blobby hears the room</span>
                    </span>
                  </button>
                  <label className="source-card">
                    <span className="source-icon"><FileAudio size={18} /></span>
                    <span className="source-text">
                      <span className="source-title">My own file</span>
                      <span className="source-desc">Songs or videos</span>
                    </span>
                    <input className="sr-only" type="file" accept={ACCEPT_MEDIA} onChange={handleFileInput} />
                  </label>
                </div>
                {showYtLanding ? linkUI : <p className="drop-hint">...or drag a song onto this page</p>}
              </div>
            )}

            {mode && showYtPopover && linkUI}

            {(mode === 'link' || mode === 'file') && (
              <div className={`player-media-row${webEmbedUrl ? ' stacked' : ''}`}>
                {mode === 'link' ? (
                  linkService === 'youtube' ? (
                    (ytVideoId || ytListId) && (
                      /* The IFrame API replaces the inner div - React must never
                         touch inside .yt-player-box */
                      <div className="player-media" key={`${ytVideoId}|${ytListId}`}>
                        <div className="yt-player-box">
                          <div ref={ytPlayerBoxRef} />
                        </div>
                        {ytError && <div className="yt-error">{ytError}</div>}
                      </div>
                    )
                  ) : (
                    <div className={`player-media wide ${linkService}`}>
                      <iframe
                        ref={scIframeRef}
                        src={webEmbedUrl}
                        title={`${linkService} player`}
                        allow="autoplay; encrypted-media"
                      />
                    </div>
                  )
                ) : (
                  <div className={`player-media${hasVideo ? '' : ' collapsed'}`} ref={videoContainerRef} />
                )}

                <div className="player-side">
                  {/* Spotify/SoundCloud embeds already show the title */}
                  {!webEmbedUrl && <div className="player-title">{fileName}</div>}
                  {mode === 'link' && linkControls}
                </div>
              </div>
            )}

            {mode === 'file' && (
              <div className="transport">
                <button className="play-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                </button>
                <div
                  className={`seek-bar${scrubbing ? ' scrubbing' : ''}`}
                  ref={seekBarRef}
                  onMouseDown={onSeekMouseDown}
                  onTouchStart={onSeekTouchStart}
                >
                  <div className="seek-fill" style={{ width: seekPercent }} />
                  <div className="seek-thumb" style={{ left: seekPercent }} />
                </div>
                <span className="time">
                  {formatTime(displayProgress)} / {formatTime(duration)}
                </span>
              </div>
            )}

            {mode === 'mic' && (
              <div className="live-status">
                <span className="live-dot" />
                Listening to your microphone
              </div>
            )}

            {mode && (
              <div className="player-bottom">
                <div className="seg" role="group" aria-label="Audio source">
                  <SegItem active={activeTab === 'link'} icon={<Link2 size={14} />} label="Link"
                    onClick={() => (showYtPopover
                      ? setShowYtPopover(false)
                      : openLinkEntry(() => setShowYtPopover(true)))} />
                  <SegItem active={activeTab === 'mic'} icon={<Mic size={14} />} label="Mic"
                    onClick={startMic} />
                  <SegItem active={activeTab === 'file'} icon={<FileAudio size={14} />} label="File"
                    onClick={() => fileInputRef.current?.click()} />
                  <input ref={fileInputRef} type="file" accept={ACCEPT_MEDIA} onChange={handleFileInput} hidden />
                </div>

                {mode === 'link' && linkService !== 'spotify' && (
                  <button
                    className="icon-btn"
                    aria-pressed={ytLoop}
                    onClick={toggleYtLoop}
                    aria-label="Loop"
                    title="Replay the video or playlist when it ends"
                  >
                    <Repeat size={16} />
                  </button>
                )}

                {document.fullscreenEnabled && (
                  <button className="icon-btn" onClick={toggleFullscreen} aria-label="Fullscreen" title="Fullscreen">
                    <Maximize size={16} />
                  </button>
                )}

                <button
                  className="icon-btn"
                  onClick={() => setPlayerHidden(true)}
                  aria-label="Hide controls"
                  title="Hide controls"
                >
                  <ChevronDown size={18} />
                </button>
              </div>
            )}
          </motion.div>
        </AutoHeight>
      </motion.div>
    </div>
    </MotionConfig>
  );
}

export default App;
