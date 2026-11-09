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

  guestPC: null,
  micTx: null,
  remoteStream: null,
  pendingCandidates: [],

  rosterCount: 2,
  peerLibPromise: null,
  reconnecting: false,

  silentTrack: null,
  audioCtx: null
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

function setError(which, message) {
  const node = which === 'create' ? createError : joinError;
  node.textContent = message;
  node.hidden = false;
}

function clearError(which) {
  const node = which === 'create' ? createError : joinError;
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
  history.replaceState(null, '', '#room=' + encodeURIComponent(state.room));

  stageVideo.muted = true;

  if (state.role === 'host') {
    updateShareButtons();
    setStagePlaceholder('Показ не начат', 'Нажмите «Показать экран» и выберите окно с сериалом или весь рабочий стол.');
    setStatus('online', 'Комната открыта');
    addSystem('Комната открыта. Отправьте ссылку жене — пароль скажите отдельно.');
  } else {
    shareBtn.hidden = true;
    stopBtn.hidden = true;
    setStagePlaceholder('Ждём показ', 'Как только начнётся трансляция, экран появится здесь.');
    setStatus('connecting', 'Вы в комнате');
    addSystem('Вы вошли в комнату «' + state.room + '».');
  }

  updateRoster();
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
    if (!guestAudio.srcObject) guestAudio.srcObject = new MediaStream();
    guestAudio.srcObject.addTrack(event.track);
    guestAudio.play().catch(() => {});
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
  } catch (err) {
    toast('Соединение с гостем не установилось: ' + (err && err.message ? err.message : 'ошибка'));
  }
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
    case 'share-stopped': {
      if (state.guestPC) guestStopPlayback();
      setStagePlaceholder('Показ остановлен', 'Как только хозяин снова включит показ, экран появится здесь.');
      setStatus('online', 'Вы в комнате');
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

  pc.onicecandidate = (event) => {
    if (event.candidate) send(state.hostConn, { t: 'ice', c: event.candidate.toJSON() });
  };

  pc.ontrack = (event) => {
    if (!state.remoteStream) state.remoteStream = new MediaStream();
    state.remoteStream.addTrack(event.track);
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
  свой микрофон (sendonly) и пустую дорожку под микрофон гостя (recvonly).
  На стороне гостя направления нужно развернуть, иначе последняя дорожка
  останется «только для приёма» и микрофон не заработает.
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

  const micIndex = lines.findIndex((line) => line.kind === 'audio' && line.direction === 'recvonly');
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
    return { kind, direction: match ? match[1] : 'sendrecv' };
  });
}

function reverseDirection(direction) {
  if (direction === 'sendonly') return 'recvonly';
  if (direction === 'recvonly') return 'sendonly';
  return direction;
}

function playRemoteStream() {
  stageVideo.srcObject = state.remoteStream;
  stageVideo.muted = false;
  stageVideo.play()
    .then(() => {
      stageEmpty.hidden = true;
      soundUnlock.hidden = true;
    })
    .catch(() => {
      stageVideo.muted = true;
      stageVideo.play().catch(() => {});
      soundUnlock.hidden = false;
      stageEmpty.hidden = true;
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
  state.pendingCandidates = [];
  stageVideo.srcObject = null;
  soundUnlock.hidden = true;
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

async function toggleMic() {
  if (!state.micOn) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      toast('Браузер не даёт доступ к микрофону.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
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

  micBtn.classList.toggle('is-on', state.micOn);
  micBtn.setAttribute('aria-pressed', state.micOn ? 'true' : 'false');
  micBtn.textContent = state.micOn ? 'Микрофон включён' : 'Микрофон';
  applyMicTrack();
}

function applyMicTrack() {
  const track = state.micOn && state.micStream ? state.micStream.getAudioTracks()[0] : getSilentTrack();

  if (state.role === 'host') {
    state.guests.forEach((guest) => {
      if (guest.txs && guest.txs.mic) guest.txs.mic.sender.replaceTrack(track || null).catch(() => {});
    });
  } else if (state.micTx) {
    state.micTx.sender.replaceTrack(track || null).catch(() => {});
  }
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
  if (state.peer) {
    try { state.peer.destroy(); } catch (err) { /* уже закрыт */ }
    state.peer = null;
  }

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

  soundUnlock.addEventListener('click', () => {
    stageVideo.muted = false;
    stageVideo.play().then(() => {
      soundUnlock.hidden = true;
    }).catch(() => {});
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.fullscreenElement) {
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
