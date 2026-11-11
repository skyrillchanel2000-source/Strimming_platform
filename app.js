'use strict';

/* ------------------------------------------------------------------
   Настройки
   ------------------------------------------------------------------ */

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

/*
  Если у вас или у жены «строгий» NAT и связь не устанавливается,
  добавьте сюда TURN-сервер (см. README, раздел «Если не соединяется»):
  { urls: 'turn:...', username: '...', credential: '...' }
*/

const PEER_OPTIONS = { debug: 1, config: { iceServers: ICE_SERVERS } };

const PEER_LIB_URLS = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
];

const MAX_GUESTS = 6;
const ROOM_ID_PREFIX = 'vmeste-';
const APP_VERSION = '2026-11-11.2';

/* ------------------------------------------------------------------
   Элементы страницы
   ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const lobbyEl = $('lobby');
const roomEl = $('room');
const createForm = $('create-form');
const joinForm = $('join-form');
const createError = $('create-error');
const joinError = $('join-error');
const createBtn = $('create-btn');
const joinBtn = $('join-btn');

const roomTitle = $('room-title');
const statusDot = $('status-dot');
const statusText = $('status-text');
const inviteBtn = $('invite-btn');
const leaveBtn = $('leave-btn');

const stageEl = $('stage');
const stageVideo = $('stage-video');
const stageEmpty = $('stage-empty');
const stageEmptyTitle = $('stage-empty-title');
const stageEmptySub = $('stage-empty-sub');
const soundUnlock = $('sound-unlock');
const shareBtn = $('share-btn');
const stopBtn = $('stop-btn');
const micBtn = $('mic-btn');
const fsBtn = $('fs-btn');
const viewersLine = $('viewers-line');

const chatList = $('chat-messages');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const chatCount = $('chat-count');
const guestAudio = $('guest-audio');
const toastEl = $('toast');

const mixerEl = $('mixer');
const mixerBtn = $('mixer-btn');
const mixerBadge = $('mixer-badge');
const mixerPanel = $('mixer-panel');
const voiceVolume = $('voice-volume');
const voiceVolumeOut = $('voice-volume-out');
const systemVolumeRow = $('system-volume-row');
const systemVolume = $('system-volume');
const systemVolumeOut = $('system-volume-out');
const voiceMuteBtn = $('voice-mute');
const mixerReset = $('mixer-reset');
const voiceMeterBar = $('voice-meter-bar');

const micEl = $('mic');
const micSettingsBtn = $('mic-settings-btn');
const micPanel = $('mic-panel');
const micSelect = $('mic-select');
const micMeterBar = $('mic-meter-bar');
const micHint = $('mic-hint');
const micStatus = $('mic-status');
const versionEl = $('app-version');

/* ------------------------------------------------------------------
   Состояние
   ------------------------------------------------------------------ */

const state = {
  role: null,
  room: '',
  name: '',
  peer: null,
  peerId: null,
  inRoom: false,

  hostConn: null,
  guests: new Map(),

  sharing: false,
  screenStream: null,

  micOn: false,
  micStream: null,
  micDeviceId: '',
  micMeterRaf: null,
  micMeterSource: null,
  micMeterAnalyser: null,

  guestPC: null,
  micTx: null,
  remoteStream: null,
  pendingCandidates: [],

  rosterCount: 2,
  peerLibPromise: null,
  reconnecting: false,

  silentTrack: null,
  audioCtx: null,
  wakeLock: null,

  remoteVoiceMid: null,

  mixer: {
    ctx: null,
    voiceGain: null,
    systemGain: null,
    voiceAnalyser: null,
    voiceMeterRaf: null,
    voiceTracks: new Map(),
    voiceSources: new Map(),
    systemTrack: null,
    systemSource: null,
    voice: 1,
    system: 1,
    lastVoice: 1
  },

  manualMode: false,
  manual: {
    role: null,
    pc: null,
    dc: null,
    adapter: null,
    videoTx: null,
    systemTx: null,
    micTx: null,
    guestMicTx: null,
    dummyTrack: null,
    dummyCanvas: null,
    connected: false
  }
};

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------------
   Мелкие помощники
   ------------------------------------------------------------------ */

function send(conn, msg) {
  try {
    if (conn && conn.open) conn.send(msg);
  } catch (err) {
    /* соединение могло закрыться между проверкой и отправкой */
  }
}

function formatTime(ts) {
  return timeFmt.format(new Date(ts || Date.now()));
}

function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function cleanName(value, fallback) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return name || fallback;
}

let toastTimer = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 6000);
}

function setStatus(kind, text) {
  statusDot.className = 'dot ' + kind;
  statusText.textContent = text;
}

function errorNode(which) {
  if (which === 'create') return createError;
  if (which === 'join') return joinError;
  if (which === 'm-host') return $('m-host-error');
  if (which === 'm-guest') return $('m-guest-error');
  return null;
}

function setError(which, message) {
  const node = errorNode(which);
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
}

function clearError(which) {
  const node = errorNode(which);
  if (!node) return;
  node.hidden = true;
  node.textContent = '';
}

function setBusy(which, busy) {
  const btn = which === 'create' ? createBtn : joinBtn;
  btn.disabled = busy;
  btn.textContent = busy
    ? 'Подключаемся…'
    : which === 'create'
      ? 'Создать комнату'
      : 'Войти в комнату';
}

function setStagePlaceholder(title, sub) {
  stageEmptyTitle.textContent = title;
  stageEmptySub.textContent = sub;
  stageEmpty.hidden = false;
}

/* ------------------------------------------------------------------
   Библиотека PeerJS подгружается при первом входе в комнату
   ------------------------------------------------------------------ */

function loadPeerLib() {
  if (window.Peer) return Promise.resolve();
  if (state.peerLibPromise) return state.peerLibPromise;

  state.peerLibPromise = new Promise((resolve, reject) => {
    let index = 0;

    const tryNext = () => {
      if (index >= PEER_LIB_URLS.length) {
        state.peerLibPromise = null;
        reject(new Error('peerlib'));
        return;
      }
      const script = document.createElement('script');
      script.src = PEER_LIB_URLS[index++];
      script.async = true;
      script.onload = () => {
        if (window.Peer) resolve();
        else tryNext();
      };
      script.onerror = () => tryNext();
      document.head.appendChild(script);
    };

    tryNext();
  });

  return state.peerLibPromise;
}

/* ------------------------------------------------------------------
   Идентификатор комнаты: SHA-256(название + пароль)
   ------------------------------------------------------------------ */

async function derivePeerId(room, password) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('insecure');
  }
  const raw = 'vmeste/v1|' + room.trim().toLowerCase().replace(/\s+/g, ' ') + '|' + password;
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return ROOM_ID_PREFIX + hex;
}

function errorText(err, which) {
  const type = err && err.type;
  if (err && err.message === 'insecure') {
    return 'Сайт открыт без HTTPS — браузер не даст создать комнату. Откройте адрес GitHub Pages (https://…) или localhost.';
  }
  if (err && err.message === 'peerlib') {
    return 'Не удалось загрузить библиотеку связи (cdn). Проверьте интернет и обновите страницу.';
  }
  if (type === 'unavailable-id') {
    return 'Комната с таким названием и паролем уже открыта. Смените название или пароль.';
  }
  if (type === 'peer-unavailable') {
    return which === 'join'
      ? 'Комната не найдена. Проверьте название и пароль: создатель должен держать сайт открытым, а название — совпадать буква в букву.'
      : 'Сервер связи потерял комнату. Попробуйте создать её ещё раз.';
  }
  if (type === 'browser-incompatible') {
    return 'Этот браузер не поддерживает WebRTC. Откройте сайт в Chrome, Edge, Firefox или Safari.';
  }
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return 'Нет связи с сервером сигнализации. Проверьте интернет и попробуйте снова.';
  }
  return 'Ошибка соединения: ' + (err && err.message ? err.message : 'неизвестная');
}

/* ------------------------------------------------------------------
   Лобби
   ------------------------------------------------------------------ */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  createForm.hidden = name !== 'create';
  joinForm.hidden = name !== 'join';
}

function readRoomField(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const marker = raw.indexOf('#room=');
  if (marker === -1) return raw;
  const tail = raw.slice(marker + 6).split('&')[0];
  try {
    return decodeURIComponent(tail);
  } catch (err) {
    return tail;
  }
}

async function handleCreate(event) {
  event.preventDefault();
  clearError('create');

  const room = readRoomField($('c-room').value);
  const password = $('c-pass').value;
  const name = cleanName($('c-name').value, 'Хозяин комнаты');

  if (room.length < 2) {
    setError('create', 'Название комнаты — хотя бы 2 символа.');
    $('c-room').focus();
    return;
  }
  if (password.length < 4) {
    setError('create', 'Пароль — хотя бы 4 символа. Он же прячет комнату от посторонних.');
    $('c-pass').focus();
    return;
  }

  setBusy('create', true);

  try {
    await loadPeerLib();
    const peerId = await derivePeerId(room, password);

    state.role = 'host';
    state.room = room;
    state.name = name;

    const peer = new window.Peer(peerId, PEER_OPTIONS);
    state.peer = peer;

    peer.on('open', (id) => {
      state.peerId = id;
      state.inRoom = true;
      setBusy('create', false);
      enterRoom();
    });

    peer.on('connection', onGuestConnection);

    peer.on('error', (err) => {
      setBusy('create', false);
      if (state.inRoom) {
        toast(errorText(err, 'create'));
        if (err && err.type === 'network') setStatus('connecting', 'Переподключение…');
      } else {
        setError('create', errorText(err, 'create'));
        try { peer.destroy(); } catch (e) { /* уже закрыт */ }
        state.peer = null;
      }
    });

    peer.on('disconnected', () => {
      setStatus('connecting', 'Переподключение…');
      reconnectPeer();
    });

    setTimeout(() => {
      if (!state.inRoom && state.peer === peer) {
        setBusy('create', false);
        setError('create', 'Сервер связи не отвечает. Проверьте интернет и попробуйте снова.');
      }
    }, 20000);
  } catch (err) {
    setBusy('create', false);
    setError('create', errorText(err, 'create'));
  }
}

async function handleJoin(event) {
  event.preventDefault();
  clearError('join');

  const room = readRoomField($('j-room').value);
  const password = $('j-pass').value;
  const name = cleanName($('j-name').value, 'Гость');

  if (room.length < 2) {
    setError('join', 'Введите название комнаты или вставьте ссылку целиком.');
    $('j-room').focus();
    return;
  }
  if (!password) {
    setError('join', 'Введите пароль комнаты.');
    $('j-pass').focus();
    return;
  }

  setBusy('join', true);

  try {
    await loadPeerLib();
    const peerId = await derivePeerId(room, password);

    state.role = 'guest';
    state.room = room;
    state.name = name;

    const peer = new window.Peer(null, PEER_OPTIONS);
    state.peer = peer;

    peer.on('error', (err) => {
      if (state.inRoom) {
        toast(errorText(err, 'join'));
        if (err && err.type === 'network') setStatus('connecting', 'Переподключение…');
        return;
      }
      setBusy('join', false);
      setError('join', errorText(err, 'join'));
      try { peer.destroy(); } catch (e) { /* уже закрыт */ }
      state.peer = null;
    });

    peer.on('disconnected', () => {
      if (state.inRoom) setStatus('connecting', 'Переподключение…');
      reconnectPeer();
    });

    peer.on('open', () => {
      const conn = peer.connect(peerId, { reliable: true, serialization: 'json' });
      state.hostConn = conn;

      conn.on('open', () => {
        state.inRoom = true;
        setBusy('join', false);
        enterRoom();
        send(conn, { t: 'hello', name: state.name });
      });

      conn.on('data', onHostMessage);
      conn.on('close', () => {
        if (state.inRoom) {
          addSystem('Связь с комнатой прервалась. Обновите страницу, чтобы войти снова.');
          setStatus('offline', 'Нет связи');
          guestStopPlayback();
        }
      });
    });

    setTimeout(() => {
      if (!state.inRoom && state.peer === peer) {
        setBusy('join', false);
        setError('join', 'Комната не отвечает. Создатель должен открыть сайт и не закрывать вкладку.');
      }
    }, 20000);
  } catch (err) {
    setBusy('join', false);
    setError('join', errorText(err, 'join'));
  }
}

function reconnectPeer() {
  if (state.reconnecting || !state.peer || state.peer.destroyed) return;
  state.reconnecting = true;
  setTimeout(() => {
    state.reconnecting = false;
    if (!state.peer || state.peer.destroyed) return;
    try { state.peer.reconnect(); } catch (err) { /* сеть недоступна */ }
  }, 2000);
}

/* ------------------------------------------------------------------
   Вход в комнату
   ------------------------------------------------------------------ */

function enterRoom() {
  lobbyEl.hidden = true;
  roomEl.hidden = false;
  document.title = state.room + ' — Вместе';
  roomTitle.textContent = state.room;
  if (!state.manualMode) history.replaceState(null, '', '#room=' + encodeURIComponent(state.room));
  inviteBtn.hidden = !!state.manualMode;

  stageVideo.muted = true;
  renderMixer();
  updateMicPanel();

  if (state.role === 'host') {
    updateShareButtons();
    setStagePlaceholder('Показ не начат', 'Нажмите «Показать экран» и выберите окно с сериалом или весь рабочий стол.');
    setStatus('online', 'Комната открыта');
    addSystem(state.manualMode
      ? 'Соединение установлено напрямую. Нажмите «Показать экран».'
      : 'Комната открыта. Отправьте ссылку жене — пароль скажите отдельно.');
  } else {
    shareBtn.hidden = true;
    stopBtn.hidden = true;
    setStagePlaceholder('Ждём показ', 'Как только начнётся трансляция, экран появится здесь.');
    setStatus('connecting', 'Вы в комнате');
    addSystem(state.manualMode
      ? 'Соединение установлено напрямую. Ждём показ.'
      : 'Вы вошли в комнату «' + state.room + '».');
  }

  updateRoster();
  requestWakeLock();
  refreshMicDevices();
}

/* ------------------------------------------------------------------
   Wake Lock: не даём экрану телефона гаснуть, пока открыта комната
   ------------------------------------------------------------------ */

async function requestWakeLock() {
  if (!state.inRoom || document.visibilityState !== 'visible') return;
  if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
  if (state.wakeLock) return;

  try {
    const sentinel = await navigator.wakeLock.request('screen');
    state.wakeLock = sentinel;
    sentinel.addEventListener('release', () => {
      if (state.wakeLock === sentinel) state.wakeLock = null;
    });
  } catch (err) {
    /* браузер отказал или экономит заряд — работаем как раньше */
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  const sentinel = state.wakeLock;
  state.wakeLock = null;
  if (!sentinel) return;
  try { sentinel.release(); } catch (err) { /* уже отпущен системой */ }
}

/* ------------------------------------------------------------------
   Общая часть: чат
   ------------------------------------------------------------------ */

function scrollChat(force) {
  const nearBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 90;
  if (force || nearBottom) chatList.scrollTop = chatList.scrollHeight;
}

function addMessage({ name, text, ts, mine }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (mine ? ' is-mine' : '');

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = (mine ? 'Вы' : name) + ' · ' + formatTime(ts);

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;

  wrap.append(meta, body);
  chatList.append(wrap);
  scrollChat(mine);
}

function addSystem(text) {
  const node = document.createElement('div');
  node.className = 'msg-system';
  node.textContent = text;
  chatList.append(node);
  scrollChat(false);
}

function submitChat(event) {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  if (state.role === 'guest' && !(state.hostConn && state.hostConn.open)) {
    toast('Нет связи с комнатой — сообщение не отправится.');
    return;
  }

  chatInput.value = '';
  const ts = Date.now();
  addMessage({ name: state.name, text, ts, mine: true });

  if (state.role === 'host') {
    sendToGuests({ t: 'chat', name: state.name, text, ts });
  } else {
    send(state.hostConn, { t: 'chat', text, ts });
  }
}

function sendToGuests(msg, exceptId) {
  state.guests.forEach((guest) => {
    if (!guest.ready) return;
    if (exceptId && guest.id === exceptId) return;
    send(guest.conn, msg);
  });
}

function announce(text, exceptId) {
  addSystem(text);
  sendToGuests({ t: 'system', text }, exceptId);
}

/* ------------------------------------------------------------------
   Хозяин комнаты: гости
   ------------------------------------------------------------------ */

function onGuestConnection(conn) {
  if (state.guests.size >= MAX_GUESTS) {
    conn.on('open', () => {
      send(conn, { t: 'denied', text: 'В комнате уже максимум участников.' });
      setTimeout(() => conn.close(), 400);
    });
    return;
  }

  const guest = {
    id: conn.peer,
    name: 'Гость',
    conn,
    ready: false,
    removed: false,
    pc: null,
    txs: null,
    pendingCandidates: []
  };

  state.guests.set(guest.id, guest);

  conn.on('open', () => {
    guest.helloTimer = setTimeout(() => {
      if (!guest.ready) conn.close();
    }, 10000);
  });

  conn.on('data', (msg) => onGuestMessage(guest, msg));
  conn.on('close', () => removeGuest(guest, true));
  conn.on('error', () => removeGuest(guest, true));
}

function onGuestMessage(guest, msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'hello': {
      guest.name = cleanName(msg.name, 'Гость');
      guest.ready = true;
      clearTimeout(guest.helloTimer);
      send(guest.conn, { t: 'welcome', hostName: state.name, room: state.room });
      announce(guest.name + ' подключился', guest.id);
      updateRoster();
      sendToGuests({ t: 'roster', count: state.guests.size + 1 });
      if (state.sharing) offerToGuest(guest);
      break;
    }
    case 'chat': {
      const text = String(msg.text || '').trim().slice(0, 1000);
      if (!text) return;
      const ts = msg.ts || Date.now();
      addMessage({ name: guest.name, text, ts, mine: false });
      sendToGuests({ t: 'chat', name: guest.name, text, ts }, guest.id);
      break;
    }
    case 'answer': {
      handleGuestAnswer(guest, msg.sdp);
      break;
    }
    case 'ice': {
      if (msg.c) handleGuestIce(guest, msg.c);
      break;
    }
    case 'bye': {
      removeGuest(guest, true);
      break;
    }
    default:
      break;
  }
}

function removeGuest(guest, notify) {
  if (!guest || guest.removed) return;
  guest.removed = true;
  clearTimeout(guest.helloTimer);
  closeGuestPC(guest);
  state.guests.delete(guest.id);
  try { guest.conn.close(); } catch (err) { /* уже закрыт */ }
  if (notify && state.inRoom) {
    announce(guest.name + ' вышел из комнаты');
    updateRoster();
    sendToGuests({ t: 'roster', count: state.guests.size + 1 });
  }
}

function updateRoster() {
  const count = state.role === 'host' ? state.guests.size + 1 : state.rosterCount || 2;
  chatCount.textContent = count + ' ' + plural(count, ['участник', 'участника', 'участников']);
  viewersLine.textContent = state.role === 'host'
    ? (state.guests.size === 0 ? 'Ждём гостей' : 'В комнате: ' + count)
    : 'Вы в комнате';
  if (state.role === 'host') {
    setStatus('online', state.guests.size === 0 ? 'Комната открыта' : 'В комнате: ' + count);
  }
}

/* ------------------------------------------------------------------
   Хозяин комнаты: показ экрана
   ------------------------------------------------------------------ */

async function startShare() {
  if (state.role !== 'host') return;

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    toast('Этот браузер не умеет показывать экран. Откройте сайт в Chrome, Edge, Firefox или Safari на компьютере.');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include'
    });
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
    toast('Не удалось начать показ: ' + (err && err.message ? err.message : 'неизвестная ошибка'));
    return;
  }

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    toast('В выбранном источнике нет видео.');
    return;
  }

  videoTrack.addEventListener('ended', () => stopShare());

  if (state.manualMode) {
    if (state.sharing) {
      const previous = state.screenStream;
      state.screenStream = stream;
      stageVideo.srcObject = stream;
      stageVideo.muted = true;
      stageVideo.play().catch(() => {});
      applyManualScreenTracks(stream);
      if (previous) previous.getTracks().forEach((track) => track.stop());
      toast('Источник показа заменён.');
      return;
    }
    state.screenStream = stream;
    state.sharing = true;
    stageVideo.srcObject = stream;
    stageVideo.muted = true;
    stageVideo.play().catch(() => {});
    stageEmpty.hidden = true;
    updateShareButtons();
    applyManualScreenTracks(stream);
    sendManual({ t: 'share-started' });
    addSystem('Показ экрана начат');
    return;
  }

  if (state.sharing) {
    replaceScreenStream(stream);
    return;
  }

  state.screenStream = stream;
  state.sharing = true;

  stageVideo.srcObject = stream;
  stageVideo.muted = true;
  stageVideo.play().catch(() => {});
  stageEmpty.hidden = true;

  addSystem('Показ экрана начат');
  sendToGuests({ t: 'system', text: 'Начался показ экрана' });

  updateShareButtons();
  state.guests.forEach((guest) => {
    if (guest.ready) offerToGuest(guest);
  });
}

function replaceScreenStream(stream) {
  const previous = state.screenStream;
  state.screenStream = stream;

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] || getSilentTrack();

  state.guests.forEach((guest) => {
    if (!guest.txs) return;
    guest.txs.video.sender.replaceTrack(videoTrack).catch(() => {});
    if (audioTrack) guest.txs.system.sender.replaceTrack(audioTrack).catch(() => {});
  });

  stageVideo.srcObject = stream;
  stageVideo.play().catch(() => {});

  if (previous) previous.getTracks().forEach((track) => track.stop());
  toast('Источник показа заменён.');
}

function stopShare() {
  if (!state.sharing) return;

  state.sharing = false;
  if (state.screenStream) state.screenStream.getTracks().forEach((track) => track.stop());
  state.screenStream = null;

  if (state.manualMode) {
    if (state.manual.videoTx) state.manual.videoTx.sender.replaceTrack(getDummyVideoTrack()).catch(() => {});
    const silent = getSilentTrack();
    if (state.manual.systemTx && silent) state.manual.systemTx.sender.replaceTrack(silent).catch(() => {});
    stageVideo.srcObject = null;
    setStagePlaceholder('Показ остановлен', 'Нажмите «Показать экран», чтобы продолжить.');
    updateShareButtons();
    sendManual({ t: 'share-stopped' });
    addSystem('Показ экрана остановлен');
    return;
  }

  state.guests.forEach((guest) => {
    closeGuestPC(guest);
    send(guest.conn, { t: 'share-stopped' });
  });

  stageVideo.srcObject = null;
  setStagePlaceholder('Показ остановлен', 'Нажмите «Показать экран», чтобы продолжить.');
  updateShareButtons();

  addSystem('Показ экрана остановлен');
  sendToGuests({ t: 'system', text: 'Показ экрана остановлен' });
}

function updateShareButtons() {
  if (state.role !== 'host') {
    shareBtn.hidden = true;
    stopBtn.hidden = true;
    return;
  }
  shareBtn.hidden = false;
  shareBtn.textContent = state.sharing ? 'Сменить окно' : 'Показать экран';
  stopBtn.hidden = !state.sharing;
}

/* ------------------------------------------------------------------
   Один RTCPeerConnection на гостя (хозяин — отправитель)
   ------------------------------------------------------------------ */

async function offerToGuest(guest) {
  if (!state.sharing || !state.screenStream || !guest.conn || !guest.conn.open) return;

  closeGuestPC(guest);
  guest.pendingCandidates = [];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  guest.pc = pc;

  const screen = state.screenStream;
  const videoTrack = screen.getVideoTracks()[0];
  const systemAudio = screen.getAudioTracks()[0] || getSilentTrack();
  const micTrack = state.micOn && state.micStream ? state.micStream.getAudioTracks()[0] : getSilentTrack();

  const videoTx = pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [screen] });
  const systemTx = addSendAudio(pc, systemAudio);
  const micTx = addSendAudio(pc, micTrack);
  const guestMicTx = pc.addTransceiver('audio', { direction: 'recvonly' });

  guest.txs = { video: videoTx, system: systemTx, mic: micTx, guestMic: guestMicTx };

  pc.onicecandidate = (event) => {
    if (event.candidate) send(guest.conn, { t: 'ice', c: event.candidate.toJSON() });
  };

  pc.ontrack = (event) => {
    if (event.track.kind !== 'audio') return;
    guest.voiceTrack = event.track;
    attachVoiceTrack(event.track);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      toast('Не удалось установить прямое соединение с гостем. Проверьте сети или добавьте TURN (см. README).');
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send(guest.conn, { t: 'offer', sdp: pc.localDescription.sdp });
  } catch (err) {
    toast('Не удалось подготовить показ: ' + (err && err.message ? err.message : 'ошибка'));
  }
}

function addSendAudio(pc, track) {
  if (track) return pc.addTransceiver(track, { direction: 'sendonly' });
  return pc.addTransceiver('audio', { direction: 'sendonly' });
}

async function handleGuestAnswer(guest, sdp) {
  if (!guest.pc || !sdp) return;
  try {
    await guest.pc.setRemoteDescription({ type: 'answer', sdp });
    const pending = guest.pendingCandidates || [];
    guest.pendingCandidates = [];
    for (const candidate of pending) {
      try { await guest.pc.addIceCandidate(candidate); } catch (err) { /* устаревший кандидат */ }
    }
    if (guest.txs && guest.txs.guestMic) {
      warnIfGuestMicSilent(guest.pc, guest.txs.guestMic.mid);
    }
  } catch (err) {
    toast('Соединение с гостем не установилось: ' + (err && err.message ? err.message : 'ошибка'));
  }
}

/*
  Гость на устаревшей странице не привязывает свой микрофон к дорожке,
  и хозяин не получает от него ни одного пакета. Без подсказки это выглядит
  как поломка: экран идёт, голос хозяина слышен, а обратного звука нет.
*/
function warnIfGuestMicSilent(pc, mid, attempt) {
  if (!pc || mid == null) return;
  const round = attempt || 0;

  setTimeout(async () => {
    if (round > 1) return;
    if (pc.connectionState === 'new' || pc.connectionState === 'connecting') {
      warnIfGuestMicSilent(pc, mid, round + 1);
      return;
    }
    if (pc.connectionState !== 'connected') return;

    let found = false;
    let bytes = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type !== 'inbound-rtp') return;
        if (report.kind !== 'audio' && report.mediaType !== 'audio') return;
        if (String(report.mid) !== String(mid)) return;
        found = true;
        bytes = report.bytesReceived || 0;
      });
    } catch (err) {
      return;
    }

    if (found && bytes > 0) return;
    addSystem('Микрофон собеседника не передаётся. Если у него открыта старая версия страницы, попросите перезагрузить её (Ctrl+F5).');
    toast('Звук от собеседника не идёт. Частая причина — устаревшая версия страницы у собеседника.');
  }, 6000);
}

function handleGuestIce(guest, candidate) {
  if (!guest.pc) return;
  if (!guest.pc.remoteDescription) {
    guest.pendingCandidates.push(candidate);
    return;
  }
  guest.pc.addIceCandidate(candidate).catch(() => {});
}

function closeGuestPC(guest) {
  if (guest && guest.pc) {
    try { guest.pc.close(); } catch (err) { /* уже закрыт */ }
  }
  if (guest) {
    guest.pc = null;
    guest.txs = null;
    guest.pendingCandidates = [];
    if (guest.voiceTrack) {
      detachVoiceTrack(guest.voiceTrack.id);
      guest.voiceTrack = null;
    }
    updateMicStatus();
  }
}

/* ------------------------------------------------------------------
   Гость: приём показа
   ------------------------------------------------------------------ */

function onHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'welcome': {
      setStatus('online', 'Вы в комнате');
      addSystem('Вы в комнате «' + (msg.room || state.room) + '». Хозяин: ' + (msg.hostName || 'на связи') + '.');
      break;
    }
    case 'system': {
      if (msg.text) addSystem(msg.text);
      break;
    }
    case 'chat': {
      addMessage({ name: msg.name || 'Хозяин', text: String(msg.text || ''), ts: msg.ts, mine: false });
      break;
    }
    case 'roster': {
      if (typeof msg.count === 'number') {
        state.rosterCount = msg.count;
        updateRoster();
      }
      break;
    }
    case 'offer': {
      handleHostOffer(msg.sdp);
      break;
    }
    case 'ice': {
      handleHostIce(msg.c);
      break;
    }
    case 'share-started': {
      if (state.manualMode) {
        stageEmpty.hidden = true;
        setStatus('online', 'Показ идёт');
      }
      break;
    }
    case 'share-stopped': {
      if (state.guestPC) guestStopPlayback();
      setStagePlaceholder('Показ остановлен', 'Как только хозяин снова включит показ, экран появится здесь.');
      setStatus('online', state.manualMode ? 'Соединение установлено' : 'Вы в комнате');
      break;
    }
    case 'denied': {
      toast(msg.text || 'Комната закрыта для новых участников.');
      break;
    }
    default:
      break;
  }
}

async function handleHostOffer(sdp) {
  if (!sdp) return;

  const earlyCandidates = state.pendingCandidates.slice();
  guestStopPlayback();
  setStatus('connecting', 'Подключаемся к показу…');
  setStagePlaceholder('Подключаемся…', 'Это занимает пару секунд.');

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.guestPC = pc;
  state.pendingCandidates = earlyCandidates;
  state.remoteStream = new MediaStream();
  state.remoteVoiceMid = findVoiceMid(sdp);

  pc.onicecandidate = (event) => {
    if (event.candidate) send(state.hostConn, { t: 'ice', c: event.candidate.toJSON() });
  };

  pc.ontrack = (event) => {
    if (!state.remoteStream) state.remoteStream = new MediaStream();
    if (event.track.kind === 'audio' && isVoiceTransceiver(event.transceiver)) {
      attachVoiceTrack(event.track);
      return;
    }
    state.remoteStream.addTrack(event.track);
    if (event.track.kind === 'audio') attachSystemTrack(event.track);
    playRemoteStream();
  };

  pc.onconnectionstatechange = () => {
    if (pc !== state.guestPC) return;
    if (pc.connectionState === 'connected') {
      setStatus('online', 'Показ идёт');
    } else if (pc.connectionState === 'failed') {
      setStatus('offline', 'Нет соединения');
      toast('Прямое соединение не установилось. Попросите начать показ заново или добавьте TURN (см. README).');
    }
  };

  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await applyReverseDirections(pc, sdp);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send(state.hostConn, { t: 'answer', sdp: pc.localDescription.sdp });
    applyMicTrack();

    const pending = state.pendingCandidates;
    state.pendingCandidates = [];
    for (const candidate of pending) {
      try { await pc.addIceCandidate(candidate); } catch (err) { /* устаревший кандидат */ }
    }
  } catch (err) {
    setStatus('offline', 'Ошибка соединения');
    toast('Не удалось принять показ: ' + (err && err.message ? err.message : 'ошибка'));
  }
}

/*
  Хозяин присылает: видео (sendonly), звук системы (sendonly),
  свой микрофон (sendonly) и двустороннюю аудиодорожку под микрофон гостя.
  Гость разворачивает направления и вешает свой микрофон на последнюю аудиодорожку.
*/
async function applyReverseDirections(pc, offerSdp) {
  const lines = parseMediaSections(offerSdp);
  const transceivers = pc.getTransceivers();

  lines.forEach((line, index) => {
    const tx = transceiverByIndex(transceivers, index);
    if (!tx) return;
    const direction = reverseDirection(line.direction);
    try { tx.direction = direction; } catch (err) { /* направление недоступно */ }
  });

  const audioIndexes = lines
    .map((line, index) => (line.kind === 'audio' ? index : -1))
    .filter((index) => index >= 0);
  const micIndex = audioIndexes.length ? audioIndexes[audioIndexes.length - 1] : -1;
  if (micIndex === -1) return;

  const micTx = transceiverByIndex(transceivers, micIndex);
  if (!micTx) return;

  state.micTx = micTx;
  const track = state.micOn && state.micStream ? state.micStream.getAudioTracks()[0] : getSilentTrack();
  try { await micTx.sender.replaceTrack(track || null); } catch (err) { /* останется без звука */ }
}

function transceiverByIndex(transceivers, index) {
  return transceivers.find((tx) => tx.mid === String(index)) || transceivers[index] || null;
}

function parseMediaSections(sdp) {
  const parts = String(sdp).split('\r\nm=');
  return parts.slice(1).map((part) => {
    const space = part.indexOf(' ');
    const kind = space === -1 ? part : part.slice(0, space);
    const match = part.match(/\r\na=(sendrecv|sendonly|recvonly|inactive)/);
    const mid = part.match(/(?:^|\r\n)a=mid:([^\r\n]+)/);
    return { kind, direction: match ? match[1] : 'sendrecv', mid: mid ? mid[1].trim() : null };
  });
}

/*
  В предложении хозяина порядок дорожек: видео, звук показа, микрофон хозяина,
  пустая дорожка под микрофон гостя. Голос собеседника — последняя sendonly-аудиодорожка.
*/
function findVoiceMid(sdp) {
  const audio = parseMediaSections(sdp)
    .filter((line) => line.kind === 'audio' && line.direction === 'sendonly');
  const voice = audio[audio.length - 1];
  return voice && voice.mid ? voice.mid : null;
}

function isVoiceTransceiver(tx) {
  if (!tx || tx.mid == null || state.remoteVoiceMid == null) return false;
  return String(tx.mid) === String(state.remoteVoiceMid);
}

function reverseDirection(direction) {
  if (direction === 'sendonly') return 'recvonly';
  if (direction === 'recvonly') return 'sendonly';
  return direction;
}

function playRemoteStream() {
  stageVideo.srcObject = state.remoteStream;
  stageVideo.muted = !!state.mixer.systemSource;
  stageVideo.volume = state.mixer.system;
  stageVideo.play()
    .then(() => {
      stageEmpty.hidden = true;
      refreshSoundUnlock();
    })
    .catch(() => {
      stageVideo.muted = true;
      stageVideo.play().catch(() => {});
      stageEmpty.hidden = true;
      if (!state.mixer.ctx) soundUnlock.hidden = false;
      refreshSoundUnlock();
    });
}

function handleHostIce(candidate) {
  if (!candidate) return;
  const pc = state.guestPC;
  if (!pc || !pc.remoteDescription) {
    state.pendingCandidates.push(candidate);
    return;
  }
  pc.addIceCandidate(candidate).catch(() => {});
}

function guestStopPlayback() {
  if (state.guestPC) {
    try { state.guestPC.close(); } catch (err) { /* уже закрыт */ }
  }
  state.guestPC = null;
  state.micTx = null;
  state.remoteStream = null;
  state.remoteVoiceMid = null;
  state.pendingCandidates = [];
  detachVoice();
  detachSystemTrack();
  stageVideo.srcObject = null;
  soundUnlock.hidden = true;
  updateMicStatus();
}

/* ------------------------------------------------------------------
   Микрофон
   ------------------------------------------------------------------ */

function getSilentTrack() {
  if (state.silentTrack) return state.silentTrack;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    const destination = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(destination);
    state.audioCtx = ctx;
    state.silentTrack = destination.stream.getAudioTracks()[0] || null;
    return state.silentTrack;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------
   Микрофон: выбор устройства и проверка уровня
   ------------------------------------------------------------------ */

const MIC_STORAGE_KEY = 'vmeste.mic';

function loadMicDevice() {
  try {
    const raw = localStorage.getItem(MIC_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data.deviceId === 'string') state.micDeviceId = data.deviceId;
  } catch (err) {
    /* настройки недоступны */
  }
}

function saveMicDevice() {
  try {
    localStorage.setItem(MIC_STORAGE_KEY, JSON.stringify({ deviceId: state.micDeviceId }));
  } catch (err) {
    /* приватный режим */
  }
}

function micConstraints() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (state.micDeviceId) audio.deviceId = { exact: state.micDeviceId };
  return { audio };
}

async function openMicStream() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('Браузер не даёт доступ к микрофону.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (err) {
    if (state.micDeviceId && err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      state.micDeviceId = '';
      saveMicDevice();
      refreshMicDevices();
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    }
    throw err;
  }
}

async function refreshMicDevices() {
  if (!micSelect) return;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    micSelect.disabled = true;
    return;
  }

  let devices = [];
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    devices = list.filter((device) => device.kind === 'audioinput' && device.deviceId);
  } catch (err) {
    devices = [];
  }

  micSelect.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'По умолчанию';
  micSelect.append(auto);

  devices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || ('Микрофон ' + (index + 1));
    micSelect.append(option);
  });

  if (devices.length && state.micDeviceId && !devices.some((device) => device.deviceId === state.micDeviceId)) {
    state.micDeviceId = '';
    saveMicDevice();
  }
  micSelect.value = state.micDeviceId;
  micSelect.disabled = devices.length === 0;
  updateMicPanel();
}

function updateMicPanel() {
  if (!micPanel) return;
  if (micHint) {
    micHint.textContent = state.micOn
      ? 'Скажите что-нибудь — полоска должна двигаться. Если молчит, выберите другое устройство.'
      : 'Включите микрофон кнопкой слева — полоска покажет уровень.';
  }
  if (micSelect && micSelect.value !== state.micDeviceId) micSelect.value = state.micDeviceId;
  updateMicStatus();
}

function updateMicStatus() {
  if (!micStatus) return;
  if (!state.micOn) {
    micStatus.textContent = 'Передача: микрофон выключен';
    micStatus.className = 'mic-status';
    return;
  }

  let ok = false;
  if (state.role === 'host') {
    ok = Array.from(state.guests.values()).some((guest) => (
      guest.txs && guest.txs.mic && guest.txs.mic.sender && guest.txs.mic.sender.track
    ));
  } else {
    const tx = state.micTx || findGuestMicTx();
    const track = tx && tx.sender && tx.sender.track;
    const direction = tx && tx.currentDirection;
    ok = !!(track && track.readyState === 'live' && (!direction || direction === 'sendonly' || direction === 'sendrecv'));
  }

  micStatus.textContent = ok ? 'Передача: идёт' : 'Передача: соединение ещё не готово';
  micStatus.className = 'mic-status ' + (ok ? 'is-ok' : 'is-bad');
}

function toggleMicPanel(force) {
  if (!micPanel || !micSettingsBtn) return;
  const open = typeof force === 'boolean' ? force : micPanel.hidden;
  micPanel.hidden = !open;
  micSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (open) {
    toggleMixerPanel(false);
    refreshMicDevices();
    updateMicPanel();
    tryResumeMixer();
    if (state.micOn) startMicMeter();
  } else {
    stopMicMeter();
  }
}

function startMicMeter() {
  stopMicMeter();
  if (!state.micOn || !state.micStream || !micPanel || micPanel.hidden) return;
  const ctx = ensureAudioCtx();
  if (!ctx || typeof ctx.createAnalyser !== 'function') {
    if (micHint) micHint.textContent = 'Индикатор уровня недоступен в этом браузере.';
    return;
  }
  try {
    const source = ctx.createMediaStreamSource(state.micStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    state.micMeterSource = source;
    state.micMeterAnalyser = analyser;
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      if (!state.micMeterAnalyser) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i] - 128) / 128;
        if (value > peak) peak = value;
      }
      if (micMeterBar) micMeterBar.style.width = Math.min(100, Math.round(peak * 140)) + '%';
      state.micMeterRaf = requestAnimationFrame(tick);
    };
    state.micMeterRaf = requestAnimationFrame(tick);
    tryResumeMixer();
  } catch (err) {
    if (micHint) micHint.textContent = 'Не удалось проверить уровень микрофона.';
  }
}

function stopMicMeter() {
  if (state.micMeterRaf) cancelAnimationFrame(state.micMeterRaf);
  state.micMeterRaf = null;
  if (state.micMeterSource) {
    try { state.micMeterSource.disconnect(); } catch (err) { /* уже отключён */ }
  }
  state.micMeterSource = null;
  state.micMeterAnalyser = null;
  if (micMeterBar) micMeterBar.style.width = '0%';
}

async function switchMicDevice() {
  if (!state.micOn) {
    updateMicPanel();
    return;
  }
  try {
    const stream = await openMicStream();
    if (state.micStream) state.micStream.getTracks().forEach((track) => track.stop());
    state.micStream = stream;
    applyMicTrack();
    refreshMicDevices();
    if (micPanel && !micPanel.hidden) startMicMeter();
  } catch (err) {
    toast('Не удалось переключить микрофон: ' + ((err && err.message) || 'ошибка'));
  }
}

async function toggleMic() {
  if (!state.micOn) {
    try {
      const stream = await openMicStream();
      state.micStream = stream;
      state.micOn = true;
    } catch (err) {
      toast('Микрофон недоступен: ' + (err && err.name === 'NotAllowedError' ? 'разрешение не выдано' : (err && err.message) || 'ошибка'));
      return;
    }
  } else {
    if (state.micStream) state.micStream.getTracks().forEach((track) => track.stop());
    state.micStream = null;
    state.micOn = false;
  }

  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume().catch(() => {});
  }
  tryResumeMixer();

  micBtn.classList.toggle('is-on', state.micOn);
  micBtn.setAttribute('aria-pressed', state.micOn ? 'true' : 'false');
  micBtn.textContent = state.micOn ? 'Микрофон включён' : 'Микрофон';
  applyMicTrack();
  updateMicPanel();

  if (state.micOn) {
    refreshMicDevices();
    if (micPanel && !micPanel.hidden) startMicMeter();
  } else {
    stopMicMeter();
  }
}

function findGuestMicTx() {
  const pc = state.manualMode ? state.manual.pc : state.guestPC;
  if (!pc) return null;
  const audioTxs = pc.getTransceivers().filter((tx) => (
    tx.receiver && tx.receiver.track && tx.receiver.track.kind === 'audio'
  ));
  return audioTxs.length ? audioTxs[audioTxs.length - 1] : null;
}

function applyMicTrack() {
  const track = state.micOn && state.micStream ? state.micStream.getAudioTracks()[0] : getSilentTrack();

  if (state.manualMode) {
    let tx = state.role === 'host' ? state.manual.micTx : state.micTx;
    if (!tx && state.role !== 'host') {
      tx = findGuestMicTx();
      state.micTx = tx;
    }
    if (tx) tx.sender.replaceTrack(track || null).catch(() => {});
    return;
  }

  if (state.role === 'host') {
    state.guests.forEach((guest) => {
      if (guest.txs && guest.txs.mic) guest.txs.mic.sender.replaceTrack(track || null).catch(() => {});
    });
  } else {
    let tx = state.micTx;
    if (!tx) {
      tx = findGuestMicTx();
      state.micTx = tx;
    }
    if (tx) tx.sender.replaceTrack(track || null).catch(() => {});
  }

  updateMicStatus();
}

/* ------------------------------------------------------------------
   Микшер громкости: голос собеседника и звук показа
   ------------------------------------------------------------------ */

const MIXER_STORAGE_KEY = 'vmeste.mixer';

function clampValue(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function ensureAudioCtx() {
  if (state.mixer.ctx) return state.mixer.ctx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  try {
    state.mixer.ctx = new AudioCtx();
  } catch (err) {
    return null;
  }
  const ctx = state.mixer.ctx;
  if (ctx.addEventListener) ctx.addEventListener('statechange', refreshSoundUnlock);
  return ctx;
}

function ensureMixerGain(kind) {
  const ctx = ensureAudioCtx();
  if (!ctx) return null;
  const m = state.mixer;
  const key = kind === 'voice' ? 'voiceGain' : 'systemGain';
  if (m[key]) return m[key];
  const gain = ctx.createGain();
  gain.gain.value = kind === 'voice' ? m.voice : m.system;
  gain.connect(ctx.destination);
  m[key] = gain;
  return gain;
}

function ensureVoiceAnalyser() {
  const m = state.mixer;
  if (m.voiceAnalyser) return m.voiceAnalyser;
  const gain = ensureMixerGain('voice');
  if (!gain || !m.ctx || typeof m.ctx.createAnalyser !== 'function') return null;
  const analyser = m.ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(gain);
  m.voiceAnalyser = analyser;
  return analyser;
}

function startVoiceMeter() {
  stopVoiceMeter();
  const m = state.mixer;
  if (!mixerPanel || mixerPanel.hidden || !m.voiceAnalyser) return;

  const analyser = m.voiceAnalyser;
  const data = new Uint8Array(analyser.fftSize);

  const tick = () => {
    if (!m.voiceAnalyser) return;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i] - 128) / 128;
      if (value > peak) peak = value;
    }
    if (voiceMeterBar) voiceMeterBar.style.width = Math.min(100, Math.round(peak * 140)) + '%';
    m.voiceMeterRaf = requestAnimationFrame(tick);
  };

  m.voiceMeterRaf = requestAnimationFrame(tick);
  tryResumeMixer();
}

function stopVoiceMeter() {
  const m = state.mixer;
  if (m.voiceMeterRaf) cancelAnimationFrame(m.voiceMeterRaf);
  m.voiceMeterRaf = null;
  if (voiceMeterBar) voiceMeterBar.style.width = '0%';
}

function applyGain(kind) {
  const m = state.mixer;
  const gain = kind === 'voice' ? m.voiceGain : m.systemGain;
  if (!gain) return;
  const value = kind === 'voice' ? m.voice : m.system;
  try {
    if (m.ctx && gain.gain.setTargetAtTime) {
      gain.gain.setTargetAtTime(value, m.ctx.currentTime, 0.015);
    } else {
      gain.gain.value = value;
    }
  } catch (err) {
    gain.gain.value = value;
  }
}

function attachVoiceTrack(track) {
  if (!track) return;
  const m = state.mixer;
  if (m.voiceTracks.has(track.id)) return;

  m.voiceTracks.set(track.id, track);
  track.addEventListener('ended', () => detachVoiceTrack(track.id));

  const gain = ensureMixerGain('voice');
  let source = null;
  if (gain && m.ctx) {
    const destination = ensureVoiceAnalyser() || gain;
    try {
      source = m.ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(destination);
    } catch (err) {
      source = null;
    }
  }

  if (source) {
    m.voiceSources.set(track.id, source);
    stopElementVoice();
  } else {
    addElementVoice(track);
  }

  refreshSoundUnlock();
  if (mixerPanel && !mixerPanel.hidden) startVoiceMeter();
}

function detachVoiceTrack(id) {
  const m = state.mixer;
  const source = m.voiceSources.get(id);
  if (source) {
    try { source.disconnect(); } catch (err) { /* уже отключён */ }
    m.voiceSources.delete(id);
  }
  m.voiceTracks.delete(id);

  if (guestAudio && guestAudio.srcObject) {
    const track = guestAudio.srcObject.getTracks().find((item) => item.id === id);
    if (track) guestAudio.srcObject.removeTrack(track);
  }
}

function detachVoice() {
  const m = state.mixer;
  m.voiceSources.forEach((source) => {
    try { source.disconnect(); } catch (err) { /* уже отключён */ }
  });
  m.voiceSources.clear();
  m.voiceTracks.clear();
  stopElementVoice();
}

function stopElementVoice() {
  if (!guestAudio) return;
  guestAudio.pause();
  guestAudio.srcObject = null;
  guestAudio.muted = true;
}

function addElementVoice(track) {
  if (!guestAudio) return;
  if (!guestAudio.srcObject) guestAudio.srcObject = new MediaStream();
  guestAudio.srcObject.addTrack(track);
  guestAudio.muted = false;
  guestAudio.volume = Math.min(1, state.mixer.voice);
  guestAudio.play().catch(() => {});
}

function attachSystemTrack(track) {
  if (!track) return;
  const m = state.mixer;
  if (m.systemTrack && m.systemTrack.id === track.id) return;

  detachSystemTrack();
  m.systemTrack = track;

  const gain = ensureMixerGain('system');
  if (gain && m.ctx) {
    try {
      m.systemSource = m.ctx.createMediaStreamSource(new MediaStream([track]));
      m.systemSource.connect(gain);
    } catch (err) {
      m.systemSource = null;
    }
  }

  if (stageVideo) {
    stageVideo.muted = !!m.systemSource;
    if (!m.systemSource) stageVideo.volume = m.system;
  }
  refreshSoundUnlock();
}

function detachSystemTrack() {
  const m = state.mixer;
  if (m.systemSource) {
    try { m.systemSource.disconnect(); } catch (err) { /* уже отключён */ }
  }
  m.systemSource = null;
  m.systemTrack = null;
  if (stageVideo) stageVideo.muted = true;
}

function setVoiceLevel(value, options) {
  const m = state.mixer;
  const next = clampValue(value, 0, 3);
  if (next > 0) m.lastVoice = next;
  m.voice = next;

  applyGain('voice');
  if (!m.voiceSources.size && guestAudio && guestAudio.srcObject && !guestAudio.muted) {
    guestAudio.volume = Math.min(1, next);
  }
  renderMixer();
  if (options && options.save) saveMixerState();
}

function setSystemLevel(value, options) {
  const m = state.mixer;
  m.system = clampValue(value, 0, 1);

  applyGain('system');
  if (!m.systemSource && stageVideo) stageVideo.volume = m.system;
  renderMixer();
  if (options && options.save) saveMixerState();
}

function toggleVoiceMute() {
  const muted = state.mixer.voice === 0;
  setVoiceLevel(muted ? (state.mixer.lastVoice || 1) : 0, { save: true });
}

function resetMixer() {
  setVoiceLevel(1, { save: true });
  setSystemLevel(1, { save: true });
}

function renderMixer() {
  const m = state.mixer;
  const voicePercent = Math.round(m.voice * 100);
  const systemPercent = Math.round(m.system * 100);

  if (voiceVolume) voiceVolume.value = String(voicePercent);
  if (voiceVolumeOut) voiceVolumeOut.textContent = voicePercent + '%';
  if (systemVolume) systemVolume.value = String(systemPercent);
  if (systemVolumeOut) systemVolumeOut.textContent = systemPercent + '%';
  if (mixerBadge) mixerBadge.textContent = m.voice === 0 ? 'выкл' : voicePercent + '%';
  if (systemVolumeRow) systemVolumeRow.hidden = state.role !== 'guest';

  if (voiceMuteBtn) {
    const muted = m.voice === 0;
    voiceMuteBtn.textContent = muted ? 'Включить голос' : 'Заглушить';
    voiceMuteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    voiceMuteBtn.classList.toggle('is-on', muted);
  }
}

function refreshSoundUnlock() {
  if (!soundUnlock) return;
  const m = state.mixer;
  const mixing = !!(m.voiceSources.size || m.systemSource);
  soundUnlock.hidden = !(mixing && m.ctx && m.ctx.state === 'suspended');
}

function tryResumeMixer() {
  const ctx = state.mixer.ctx;
  if (!ctx) return;
  if (ctx.state === 'running') {
    refreshSoundUnlock();
    return;
  }
  const done = () => refreshSoundUnlock();
  try {
    const result = ctx.resume();
    if (result && typeof result.then === 'function') result.then(done).catch(done);
    else done();
  } catch (err) {
    done();
  }
}

function primeAudio() {
  ensureAudioCtx();
  tryResumeMixer();
}

function unlockSound() {
  tryResumeMixer();
  if (guestAudio && guestAudio.srcObject && guestAudio.paused) guestAudio.play().catch(() => {});
  if (state.role === 'guest' && stageVideo.paused) stageVideo.play().catch(() => {});
}

function saveMixerState() {
  try {
    localStorage.setItem(MIXER_STORAGE_KEY, JSON.stringify({
      voice: state.mixer.voice,
      system: state.mixer.system
    }));
  } catch (err) {
    /* приватный режим или хранилище недоступно */
  }
}

function loadMixerState() {
  try {
    const raw = localStorage.getItem(MIXER_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data.voice === 'number') {
      state.mixer.voice = clampValue(data.voice, 0, 3);
      if (state.mixer.voice > 0) state.mixer.lastVoice = state.mixer.voice;
    }
    if (data && typeof data.system === 'number') {
      state.mixer.system = clampValue(data.system, 0, 1);
    }
  } catch (err) {
    /* повреждённые настройки — остаются значения по умолчанию */
  }
}

function toggleMixerPanel(force) {
  if (!mixerPanel || !mixerBtn) return;
  const open = typeof force === 'boolean' ? force : mixerPanel.hidden;
  mixerPanel.hidden = !open;
  mixerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');

  if (open) {
    startVoiceMeter();
    toggleMicPanel(false);
  } else {
    stopVoiceMeter();
  }
}

/* ------------------------------------------------------------------
   Ручное соединение: обмен кодами без сервера сигнализации
   ------------------------------------------------------------------ */

function getDummyVideoTrack() {
  const m = state.manual;
  if (m.dummyTrack) return m.dummyTrack;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 9;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#04060b';
      ctx.fillRect(0, 0, 16, 9);
    }
    const stream = canvas.captureStream(1);
    m.dummyCanvas = canvas;
    m.dummyTrack = stream.getVideoTracks()[0] || null;
  } catch (err) {
    m.dummyTrack = null;
  }
  return m.dummyTrack;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encodeCode(sdp) {
  const bytes = new TextEncoder().encode(sdp);
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
      const packed = new Uint8Array(await new Response(stream).arrayBuffer());
      return 'V1g' + bytesToBase64(packed);
    } catch (err) {
      /* сжать не удалось — отдадим как есть */
    }
  }
  return 'V1p' + bytesToBase64(bytes);
}

async function decodeCode(raw) {
  const code = String(raw || '').replace(/\s+/g, '');
  if (!/^V1[gp]/.test(code)) throw new Error('format');

  const bytes = base64ToBytes(code.slice(3));
  if (code.charAt(2) === 'p') return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream !== 'function') throw new Error('format');

  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw new Error('format');
  }
}

function waitForIce(pc, timeout = 9000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, timeout);
  });
}

function channelAdapter(dc) {
  return {
    open: true,
    send(message) {
      if (dc.readyState === 'open') dc.send(JSON.stringify(message));
    },
    close() {
      try { dc.close(); } catch (err) { /* уже закрыт */ }
    }
  };
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Код скопирован.');
  } catch (err) {
    window.prompt('Скопируйте код:', text);
  }
}

function resetManual() {
  const m = state.manual;
  const adapter = m.adapter;

  if (m.pc) { try { m.pc.close(); } catch (err) { /* закрыт */ } }
  if (m.dc) { try { m.dc.close(); } catch (err) { /* закрыт */ } }

  m.role = null;
  m.pc = null;
  m.dc = null;
  m.adapter = null;
  m.videoTx = null;
  m.systemTx = null;
  m.micTx = null;
  m.guestMicTx = null;
  m.connected = false;

  detachVoice();
  detachSystemTrack();

  state.guests.delete('manual');
  if (adapter && state.hostConn === adapter) state.hostConn = null;
}

function sendManual(message) {
  send(state.manual.adapter, message);
}

function attachManualChannel(dc, role) {
  const m = state.manual;
  m.dc = dc;
  m.adapter = channelAdapter(dc);

  dc.onopen = () => {
    if (role === 'host') {
      state.guests.set('manual', {
        id: 'manual',
        name: 'Гость',
        conn: m.adapter,
        ready: true,
        removed: false,
        pc: null,
        txs: null,
        pendingCandidates: []
      });
      send(m.adapter, { t: 'welcome', hostName: state.name, room: 'Соединение напрямую' });
      send(m.adapter, { t: 'roster', count: 2 });
      updateRoster();
    } else {
      state.hostConn = m.adapter;
      send(m.adapter, { t: 'hello', name: state.name });
      updateRoster();
    }
  };

  dc.onmessage = (event) => {
    let message = null;
    try { message = JSON.parse(event.data); } catch (err) { return; }
    if (role === 'host') {
      const guest = state.guests.get('manual');
      if (guest) onGuestMessage(guest, message);
    } else {
      onHostMessage(message);
    }
  };

  dc.onclose = () => {
    if (state.inRoom) {
      addSystem('Собеседник отключился. Обновите страницу, чтобы начать заново.');
      setStatus('offline', 'Нет связи');
    }
  };
}

function switchManualTab(name) {
  document.querySelectorAll('[data-manual]').forEach((tab) => {
    const active = tab.dataset.manual === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const hostPane = $('manual-host');
  const guestPane = $('manual-guest');
  if (hostPane) hostPane.hidden = name !== 'host';
  if (guestPane) guestPane.hidden = name !== 'guest';
}

function playManualRemote() {
  stageVideo.srcObject = state.remoteStream;
  stageVideo.muted = !!state.mixer.systemSource;
  stageVideo.volume = state.mixer.system;
  stageVideo.play().catch(() => {
    stageVideo.muted = true;
    stageVideo.play().catch(() => {});
    if (!state.mixer.ctx) soundUnlock.hidden = false;
  });
  refreshSoundUnlock();
}

function applyManualScreenTracks(stream) {
  const m = state.manual;
  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0] || getSilentTrack();
  if (m.videoTx && video) m.videoTx.sender.replaceTrack(video).catch(() => {});
  if (m.systemTx && audio) m.systemTx.sender.replaceTrack(audio).catch(() => {});
}

async function manualCreateInvite() {
  clearError('m-host');
  state.name = cleanName($('m-host-name').value, 'Хозяин комнаты');
  const btn = $('m-create');
  btn.disabled = true;
  btn.textContent = 'Готовим код…';

  try {
    resetManual();
    state.manual.role = 'host';

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.manual.pc = pc;

    const dummy = getDummyVideoTrack();
    state.manual.videoTx = dummy
      ? pc.addTransceiver(dummy, { direction: 'sendonly' })
      : pc.addTransceiver('video', { direction: 'sendonly' });
    state.manual.systemTx = addSendAudio(pc, getSilentTrack());
    state.manual.micTx = addSendAudio(
      pc,
      state.micOn && state.micStream ? state.micStream.getAudioTracks()[0] : getSilentTrack()
    );
    state.manual.guestMicTx = pc.addTransceiver('audio', { direction: 'recvonly' });

    attachManualChannel(pc.createDataChannel('vmeste', { ordered: true }), 'host');

    pc.ontrack = (event) => {
      if (event.track.kind !== 'audio') return;
      attachVoiceTrack(event.track);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        state.manual.connected = true;
        setStatus('online', 'Соединение установлено');
      } else if (pc.connectionState === 'failed') {
        setError('m-host', 'Соединение не установилось. Создайте приглашение заново.');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    $('m-invite').value = await encodeCode(pc.localDescription.sdp);
    $('m-answer-in').value = '';
    $('m-host-step1').hidden = false;
    $('m-host-step2').hidden = false;
    toast('Код готов — отправьте его жене.');
  } catch (err) {
    setError('m-host', 'Не удалось создать приглашение: ' + ((err && err.message) || 'ошибка'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Создать приглашение';
  }
}

async function manualConnectAnswer() {
  clearError('m-host');
  const raw = $('m-answer-in').value;
  if (!raw.trim()) {
    setError('m-host', 'Вставьте ответный код от жены.');
    return;
  }

  const pc = state.manual.pc;
  if (!pc) {
    setError('m-host', 'Сначала создайте приглашение.');
    return;
  }

  const btn = $('m-connect');
  btn.disabled = true;
  btn.textContent = 'Соединяем…';

  try {
    const sdp = await decodeCode(raw);
    await pc.setRemoteDescription({ type: 'answer', sdp });
    state.role = 'host';
    state.manualMode = true;
    state.room = 'Соединение напрямую';
    state.inRoom = true;
    enterRoom();
    setStatus('online', 'Соединение установлено');
    if (state.manual.guestMicTx) warnIfGuestMicSilent(pc, state.manual.guestMicTx.mid);
  } catch (err) {
    setError('m-host', 'Ответный код не подошёл. Скопируйте его целиком, без лишних символов.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Подключиться';
  }
}

async function manualMakeAnswer() {
  clearError('m-guest');
  state.name = cleanName($('m-guest-name').value, 'Гость');
  const raw = $('m-invite-in').value;
  if (!raw.trim()) {
    setError('m-guest', 'Вставьте код приглашения от того, кто показывает.');
    return;
  }

  const btn = $('m-make-answer');
  btn.disabled = true;
  btn.textContent = 'Готовим ответ…';

  try {
    resetManual();
    state.manual.role = 'guest';

    const sdp = await decodeCode(raw);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.manual.pc = pc;
    state.remoteStream = new MediaStream();
    state.remoteVoiceMid = findVoiceMid(sdp);

    pc.ontrack = (event) => {
      if (!state.remoteStream) state.remoteStream = new MediaStream();
      if (event.track.kind === 'audio' && isVoiceTransceiver(event.transceiver)) {
        attachVoiceTrack(event.track);
        return;
      }
      state.remoteStream.addTrack(event.track);
      if (event.track.kind === 'audio') attachSystemTrack(event.track);
      playManualRemote();
    };

    pc.ondatachannel = (event) => attachManualChannel(event.channel, 'guest');

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        state.manual.connected = true;
        enterManualRoom();
      } else if (pc.connectionState === 'failed') {
        setError('m-guest', 'Соединение не установилось. Попросите создать приглашение заново.');
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });
    await applyReverseDirections(pc, sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    applyMicTrack();
    await waitForIce(pc);

    $('m-answer-out').value = await encodeCode(pc.localDescription.sdp);
    $('m-guest-step2').hidden = false;
    toast('Ответ готов — отправьте код обратно.');
  } catch (err) {
    const message = err && err.message === 'format'
      ? 'Код не распознан. Скопируйте его из сообщения целиком.'
      : 'Не удалось создать ответ: ' + ((err && err.message) || 'ошибка');
    setError('m-guest', message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Создать ответ';
  }
}

function enterManualRoom() {
  if (state.inRoom) return;
  state.role = 'guest';
  state.manualMode = true;
  state.room = 'Соединение напрямую';
  state.inRoom = true;
  enterRoom();
  setStagePlaceholder('Ждём показ', 'Как только он включит показ, экран появится здесь.');
}

/* ------------------------------------------------------------------
   Вспомогательные действия
   ------------------------------------------------------------------ */

function inviteLink() {
  return location.origin + location.pathname + '#room=' + encodeURIComponent(state.room);
}

async function copyInvite() {
  const link = inviteLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка скопирована. Пароль передайте отдельно.');
  } catch (err) {
    window.prompt('Скопируйте ссылку:', link);
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  if (stageEl.requestFullscreen) {
    stageEl.requestFullscreen().catch(() => toast('Полноэкранный режим недоступен.'));
  } else if (stageVideo.webkitEnterFullscreen) {
    stageVideo.webkitEnterFullscreen();
  } else {
    toast('Браузер не поддерживает полноэкранный режим.');
  }
}

function leaveRoom() {
  if (state.role === 'host') {
    sendToGuests({ t: 'system', text: 'Создатель комнаты закрыл её.' });
    state.guests.forEach((guest) => {
      closeGuestPC(guest);
      setTimeout(() => { try { guest.conn.close(); } catch (err) { /* закрыт */ } }, 200);
    });
    state.guests.clear();
    stopShare();
  } else {
    send(state.hostConn, { t: 'bye' });
    guestStopPlayback();
  }

  if (state.micStream) state.micStream.getTracks().forEach((track) => track.stop());
  if (state.manual.pc) { try { state.manual.pc.close(); } catch (err) { /* закрыт */ } }
  if (state.manual.dc) { try { state.manual.dc.close(); } catch (err) { /* закрыт */ } }
  if (state.manual.dummyTrack) { try { state.manual.dummyTrack.stop(); } catch (err) { /* закрыт */ } }
  if (state.peer) {
    try { state.peer.destroy(); } catch (err) { /* уже закрыт */ }
    state.peer = null;
  }

  detachVoice();
  detachSystemTrack();
  releaseWakeLock();

  setTimeout(() => location.reload(), 250);
}

/* ------------------------------------------------------------------
   Запуск
   ------------------------------------------------------------------ */

function init() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  createForm.addEventListener('submit', handleCreate);
  joinForm.addEventListener('submit', handleJoin);
  chatForm.addEventListener('submit', submitChat);

  shareBtn.addEventListener('click', startShare);
  stopBtn.addEventListener('click', () => stopShare());
  micBtn.addEventListener('click', toggleMic);
  fsBtn.addEventListener('click', toggleFullscreen);
  inviteBtn.addEventListener('click', copyInvite);
  leaveBtn.addEventListener('click', leaveRoom);

  loadMixerState();
  renderMixer();
  loadMicDevice();
  if (versionEl) versionEl.textContent = 'Версия ' + APP_VERSION;

  if (mixerBtn) mixerBtn.addEventListener('click', () => toggleMixerPanel());
  if (voiceVolume) {
    voiceVolume.addEventListener('input', () => {
      setVoiceLevel(Number(voiceVolume.value) / 100, { save: true });
    });
  }
  if (systemVolume) {
    systemVolume.addEventListener('input', () => {
      setSystemLevel(Number(systemVolume.value) / 100, { save: true });
    });
  }
  if (voiceMuteBtn) voiceMuteBtn.addEventListener('click', toggleVoiceMute);
  if (mixerReset) mixerReset.addEventListener('click', resetMixer);

  document.addEventListener('click', (event) => {
    if (mixerPanel && !mixerPanel.hidden && !(mixerEl && mixerEl.contains(event.target))) {
      toggleMixerPanel(false);
    }
    if (micPanel && !micPanel.hidden && !(micEl && micEl.contains(event.target))) {
      toggleMicPanel(false);
    }
  });

  if (micSettingsBtn) micSettingsBtn.addEventListener('click', () => toggleMicPanel());
  if (micSelect) {
    micSelect.addEventListener('change', () => {
      state.micDeviceId = micSelect.value;
      saveMicDevice();
      switchMicDevice();
    });
  }
  refreshMicDevices();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshMicDevices);
  }

  document.addEventListener('pointerdown', primeAudio, { passive: true });
  document.addEventListener('keydown', primeAudio);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      tryResumeMixer();
    } else {
      releaseWakeLock();
    }
  });

  const manualOpen = $('manual-open');
  const manualClose = $('manual-close');
  if (manualOpen) {
    manualOpen.addEventListener('click', () => {
      $('auth-panel').hidden = true;
      $('manual-panel').hidden = false;
    });
  }
  if (manualClose) {
    manualClose.addEventListener('click', () => {
      resetManual();
      $('manual-panel').hidden = true;
      $('auth-panel').hidden = false;
    });
  }
  document.querySelectorAll('[data-manual]').forEach((tab) => {
    tab.addEventListener('click', () => switchManualTab(tab.dataset.manual));
  });
  const manualActions = [
    ['m-create', manualCreateInvite],
    ['m-connect', manualConnectAnswer],
    ['m-make-answer', manualMakeAnswer],
    ['m-copy-invite', () => copyText($('m-invite').value)],
    ['m-copy-answer', () => copyText($('m-answer-out').value)]
  ];
  manualActions.forEach(([id, handler]) => {
    const node = $(id);
    if (node) node.addEventListener('click', handler);
  });

  soundUnlock.addEventListener('click', unlockSound);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (micPanel && !micPanel.hidden) {
      toggleMicPanel(false);
      return;
    }
    if (mixerPanel && !mixerPanel.hidden) {
      toggleMixerPanel(false);
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.peer) {
      try { state.peer.destroy(); } catch (err) { /* закрыт */ }
    }
  });

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const roomFromLink = hash.get('room');
  if (roomFromLink) {
    switchTab('join');
    $('j-room').value = roomFromLink;
    setTimeout(() => $('j-pass').focus(), 150);
  }
}

init();
