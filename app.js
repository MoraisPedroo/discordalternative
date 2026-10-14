/* =========================================================================
   Sala — voz + transmissão de tela P2P + chat, no navegador.

   - Sinalização/presença via PeerJS (broker gratuito). Áudio e vídeo vão P2P.
   - O host da sala coordena presença e chat (estrela) e valida a senha.
   - Voz e tela vão em mesh: cada par tem sua própria conexão.
   - Lista de salas: /api/rooms (função serverless do Vercel).
   ========================================================================= */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  var AVATARS = [
    '👽','🤖','👻','🐱','🦖','🐸','🦊','🐙',
    '🦄','🐼','🍄','🌮','👾','🦉','🐧','🦕',
    '🐵','🐷','🦁','🐨','🦝','🐮','🐔','🦩'
  ];

  var DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  var HOST_PREFIX = 'dalt-';
  var SELF = '__self';          // tile da minha própria tela
  var LOCAL = '__me';           // meu áudio no detector de fala
  var SPEAK_THRESHOLD = 0.05;   // RMS mínimo pra considerar "falando"
  var SPEAK_HANGOVER = 240;     // ms que o anel verde fica após parar
  var SYNC_EVERY = 4000;        // revisão periódica das conexões de mídia
  var CALL_TIMEOUT = 15000;     // chamada que não conecta nesse tempo é refeita
  var PENDING_TIMEOUT = 6000;   // espera o roster antes de recusar chamada
  var DIR_HEARTBEAT = 10000;    // host atualiza a sala na lista
  var LOBBY_POLL = 5000;        // lobby atualiza a lista

  var NS_HINTS = {
    gtcrn: 'GTCRN (2024): rede neural que remove teclado, ventilador e barulho de fundo com mais força. A voz sai com banda de ~8 kHz.',
    rnnoise: 'RNNoise (2018): voz em banda cheia (mais nítida), porém remove bem menos ruído que o GTCRN.',
    browser: 'Supressão nativa do navegador (WebRTC).',
    off: 'Sem filtro: som cru do microfone (só cancelamento de eco).'
  };

  // ---------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------
  var me = { name: '', avatar: '', id: null };
  var roomId = null;
  var isHost = false;
  var everMember = false;
  var leaving = false;
  var roomMeta = { name: '', private: false, passHash: null, dirToken: null };
  var myPassHash = null;
  var iceServers = DEFAULT_ICE;
  var icePromise = null;

  var peer = null;
  var hostConn = null;
  var memberConns = {};         // (host) peerId -> DataConnection admitida
  var roster = {};              // peerId -> { name, avatar, live, muted }
  var reconnectTimer = null;
  var failedHostAttempts = 0;
  var syncTimer = null;
  var pendingCalls = [];

  // Tela
  var localStream = null;
  var outgoingCalls = {};       // peerId -> MediaConnection (minha tela → ele)
  var tiles = {};               // peerId|SELF -> { tile, video, call, ... }
  var prevLive = {};

  // Voz
  var audioCtx = null;
  var silentStream = null;
  var sendStream = null, sendTrack = null;
  var micPipe = null, micBuildSeq = 0, micEnabled = true;
  var aiFailed = false;         // a rede neural quebrou nesta sessão → usa a do navegador
  var voiceCalls = {};          // peerId -> MediaConnection (voz)
  var voiceAudios = {};         // peerId -> <audio>
  var selectedMicId = null, selectedOutputId = null, noiseMode = 'gtcrn';
  var loopAudio = null;
  var audioLocked = false;

  // Detector de fala
  var analysers = {};
  var speakingState = {};
  var peopleAvatarEls = {};
  var localMicLevel = 0;
  var vadRunning = false;

  // PiP
  var pipActive = false, pipCanvas = null, pipCtx = null, pipVideo = null;

  // Lobby / diretório
  var dirTimer = null, dirDebounce = null;
  var lobbyTimer = null, lobbyFails = 0, lobbyLoaded = false;
  var cardEls = {};
  var inviteRoom = null;
  var pendingJoin = null;
  var createType = 'public';

  var settingsOpen = false;
  var seenMsgIds = {};
  var roomUiBound = false;

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  }
  function connState(kind, text) {
    var c = $('connState'); c.textContent = text; c.className = 'conn-state' + (kind ? ' ' + kind : '');
  }
  function pref(key, value) {
    try {
      if (value === undefined) return localStorage.getItem('sala.' + key);
      if (value === null) localStorage.removeItem('sala.' + key);
      else localStorage.setItem('sala.' + key, value);
    } catch (e) {}
    return null;
  }

  function hashStr(s) { var h = 0; for (var i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return Math.abs(h); }
  function avatarStyle(seed) {
    var h = hashStr(seed || 'x') % 360;
    return 'linear-gradient(135deg, hsl(' + h + ',70%,55%), hsl(' + ((h + 40) % 360) + ',70%,45%))';
  }
  function avatarColor(seed) { return 'hsl(' + (hashStr(seed || 'x') % 360) + ',66%,52%)'; }
  function avatarEl(p, cls) {
    var a = el('div', cls || 'ava');
    a.textContent = (p && p.avatar) || '❓';
    a.style.background = avatarStyle((p && p.name) || 'x');
    return a;
  }

  function randomChars(n) {
    var a = new Uint8Array(n);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join('');
  }
  function genCode() { return randomChars(6); }
  function uid() { return Date.now().toString(36) + randomChars(5); }

  function sha256Hex(str) {
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
    }
    return Promise.resolve('h' + hashStr(str).toString(16)); // contexto inseguro (sem WebRTC de qualquer jeito)
  }
  function passHashFor(id, password) { return sha256Hex('sala:' + id + ':' + password); }

  function inviteUrl() { return location.origin + location.pathname + '?sala=' + roomId; }
  function hostId() { return HOST_PREFIX + roomId; }
  function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Anônimo'; }
  function cleanAvatar(a) { return AVATARS.indexOf(a) >= 0 ? a : '❓'; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function loadIce() {
    icePromise = fetch('/api/ice', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && Array.isArray(d.iceServers) && d.iceServers.length) iceServers = d.iceServers; })
      .catch(function () {});
    return icePromise;
  }
  function peerOptions() { return { debug: 1, config: { iceServers: iceServers } }; }

  // =====================================================================
  // TEMA
  // =====================================================================
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
  function setTheme(t) { document.documentElement.setAttribute('data-theme', t); pref('theme', t); updateThemeUI(); }
  function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
  function updateThemeUI() {
    var t = currentTheme();
    $('themeDark').classList.toggle('active', t === 'dark');
    $('themeLight').classList.toggle('active', t === 'light');
  }

  // =====================================================================
  // LOBBY
  // =====================================================================
  function initLobby() {
    updateThemeUI();
    Array.prototype.forEach.call(document.querySelectorAll('.theme-btn'), function (b) { b.addEventListener('click', toggleTheme); });

    selectedMicId = pref('micId');
    selectedOutputId = pref('outId');
    noiseMode = pref('noise') || 'gtcrn';
    if (!NS_HINTS[noiseMode]) noiseMode = 'gtcrn';

    // Perfil
    var grid = $('avatarGrid');
    AVATARS.forEach(function (emoji, i) {
      var b = el('button', 'avatar-opt');
      b.type = 'button'; b.textContent = emoji; b.style.background = avatarStyle(emoji + i);
      b.setAttribute('role', 'option');
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('selected'); c.setAttribute('aria-selected', 'false'); });
        b.classList.add('selected'); b.setAttribute('aria-selected', 'true');
        me.avatar = emoji; pref('avatar', emoji);
      });
      grid.appendChild(b);
    });
    var startIdx = AVATARS.indexOf(pref('avatar'));
    if (startIdx < 0) startIdx = Math.floor(Math.random() * AVATARS.length);
    grid.children[startIdx].click();

    var nameInput = $('nameInput');
    nameInput.value = pref('name') || '';
    nameInput.addEventListener('input', updateRoomNamePlaceholder);
    updateRoomNamePlaceholder();

    // Criar sala
    $('typePublic').addEventListener('click', function () { setCreateType('public'); });
    $('typePrivate').addEventListener('click', function () { setCreateType('private'); });
    $('createBtn').addEventListener('click', onCreate);
    $('roomNameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') onCreate(); });
    $('roomPassInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') onCreate(); });

    // Senha
    $('passForm').addEventListener('submit', onPassSubmit);
    $('passCancel').addEventListener('click', closePass);
    $('passClose').addEventListener('click', closePass);
    $('passOverlay').addEventListener('click', function (e) { if (e.target === $('passOverlay')) closePass(); });

    // Convite por link
    var params = new URLSearchParams(location.search);
    var urlRoom = (params.get('sala') || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 16);
    var auth = params.get('auth');
    if (auth) { try { history.replaceState(null, '', '?sala=' + urlRoom); } catch (e) {} }
    if (urlRoom) showInvite(urlRoom, auth);

    loadIce();
    startLobbyPolling();
  }

  function updateRoomNamePlaceholder() {
    var n = $('nameInput').value.trim();
    $('roomNameInput').placeholder = 'Sala de ' + (n || 'você');
  }

  function setCreateType(type) {
    createType = type;
    var priv = type === 'private';
    $('typePublic').classList.toggle('active', !priv);
    $('typePrivate').classList.toggle('active', priv);
    $('typePublic').setAttribute('aria-checked', String(!priv));
    $('typePrivate').setAttribute('aria-checked', String(priv));
    $('roomPassRow').classList.toggle('hidden', !priv);
    $('typeHint').textContent = priv
      ? 'Aparece na lista com cadeado e sem prévia da tela. Só entra quem tiver a senha.'
      : 'Aparece na lista pra todo mundo, com prévia da tela.';
    if (priv) $('roomPassInput').focus();
  }

  function ensureProfile() {
    var name = $('nameInput').value.trim();
    if (!name) {
      toast('Escolha um nome pra entrar 🙂');
      $('nameInput').focus();
      $('nameInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    me.name = cleanName(name);
    pref('name', me.name);
    return true;
  }

  function onCreate() {
    if (!ensureProfile()) return;
    var priv = createType === 'private';
    var pass = $('roomPassInput').value;
    if (priv && pass.length < 3) { toast('A senha precisa ter pelo menos 3 caracteres'); $('roomPassInput').focus(); return; }
    var name = $('roomNameInput').value.trim().slice(0, 40) || ('Sala de ' + me.name);
    var id = genCode();
    $('createBtn').disabled = true;
    (priv ? passHashFor(id, pass) : Promise.resolve(null)).then(function (hash) {
      enterRoom(id, { name: name, private: priv, passHash: hash, create: true });
    });
  }

  function joinRoom(room) {
    if (!room || !ensureProfile()) return;
    if (room.private) openPass(room);
    else enterRoom(room.id, { name: room.name, private: false });
  }

  // ---------- senha ----------
  function openPass(room, error) {
    pendingJoin = room;
    $('passRoomName').textContent = room.name || 'Sala privada';
    $('passInput').value = '';
    $('passError').textContent = error || '';
    $('passError').classList.toggle('hidden', !error);
    $('passOverlay').classList.remove('hidden');
    setTimeout(function () { $('passInput').focus(); }, 30);
  }
  function closePass() { $('passOverlay').classList.add('hidden'); pendingJoin = null; }
  function onPassSubmit(e) {
    e.preventDefault();
    var pass = $('passInput').value;
    if (!pass) { $('passError').textContent = 'Digite a senha.'; $('passError').classList.remove('hidden'); return; }
    var room = pendingJoin;
    if (!room) return;
    if (!ensureProfile()) { closePass(); return; }
    passHashFor(room.id, pass).then(function (hash) {
      closePass();
      enterRoom(room.id, { name: room.name, private: true, passHash: hash });
    });
  }

  // ---------- convite ----------
  function showInvite(id, authReason) {
    inviteRoom = { id: id, name: 'Sala ' + id, private: !!authReason, people: [] };
    $('inviteBox').classList.remove('hidden');
    $('inviteName').textContent = inviteRoom.name;
    $('inviteMeta').textContent = 'carregando…';
    $('inviteBtn').addEventListener('click', function () { joinRoom(inviteRoom); });

    fetch('/api/rooms?id=' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.room) updateInvite(d.room);
        else $('inviteMeta').textContent = inviteRoom.private ? '🔒 Sala privada' : 'Fora da lista agora — dá pra tentar entrar mesmo assim';
      })
      .catch(function () { $('inviteMeta').textContent = ''; });

    if (authReason) {
      setTimeout(function () {
        openPass(inviteRoom, authReason === 'wrong' ? 'Senha incorreta. Tente de novo.' : 'Essa sala é privada. Digite a senha.');
      }, 60);
    }
  }
  function updateInvite(r) {
    inviteRoom = { id: r.id, name: r.name || ('Sala ' + r.id), private: !!r.private || !!(inviteRoom && inviteRoom.private), people: r.people || [] };
    $('inviteName').textContent = inviteRoom.name;
    var n = inviteRoom.people.length;
    var parts = [inviteRoom.private ? '🔒 Privada' : '🌐 Pública', n + (n === 1 ? ' pessoa' : ' pessoas')];
    if (r.liveBy) parts.push('🔴 ' + r.liveBy + ' ao vivo');
    $('inviteMeta').textContent = parts.join(' · ');
    $('inviteBtn').textContent = inviteRoom.private ? 'Entrar 🔒' : 'Entrar';
  }

  // ---------- lista de salas ----------
  function startLobbyPolling() {
    fetchRooms();
    lobbyTimer = setInterval(function () { if (!document.hidden) fetchRooms(); }, LOBBY_POLL);
  }
  function stopLobbyPolling() { if (lobbyTimer) clearInterval(lobbyTimer); lobbyTimer = null; }

  function fetchRooms() {
    fetch('/api/rooms', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (d) { lobbyFails = 0; lobbyLoaded = true; renderRooms(d.rooms || []); })
      .catch(function () { lobbyFails++; if (!lobbyLoaded || lobbyFails >= 3) renderRoomsOff(); });
  }

  function renderRooms(rooms) {
    $('roomsOff').classList.add('hidden');
    $('roomsStatus').classList.remove('hidden');
    $('roomCount').textContent = rooms.length;
    $('roomsEmpty').classList.toggle('hidden', rooms.length > 0);

    var list = $('roomList'), seen = {};
    rooms.forEach(function (r, i) {
      seen[r.id] = true;
      var card = cardEls[r.id] || (cardEls[r.id] = buildCard());
      updateCard(card, r);
      if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
      if (inviteRoom && inviteRoom.id === r.id) updateInvite(r);
    });
    Object.keys(cardEls).forEach(function (id) {
      if (seen[id]) return;
      var c = cardEls[id]; if (c.parentNode) c.parentNode.removeChild(c);
      delete cardEls[id];
    });
  }

  function renderRoomsOff() {
    $('roomsOff').classList.remove('hidden');
    $('roomsEmpty').classList.add('hidden');
    $('roomsStatus').classList.add('hidden');
    $('roomCount').textContent = '0';
    Object.keys(cardEls).forEach(function (id) { var c = cardEls[id]; if (c.parentNode) c.parentNode.removeChild(c); });
    cardEls = {};
  }

  function buildCard() {
    var card = el('div', 'room-card');
    card.tabIndex = 0; card.setAttribute('role', 'button');

    var pv = el('div', 'rc-preview');
    var img = el('img', 'rc-img hidden'); img.alt = ''; img.decoding = 'async';
    var ph = el('div', 'rc-ph');
    var badges = el('div', 'rc-badges');
    var live = el('span', 'rc-badge live hidden'); live.appendChild(el('span', 'dot'));
    var liveTxt = el('span'); live.appendChild(liveTxt);
    var lock = el('span', 'rc-badge hidden'); lock.textContent = '🔒 Privada';
    badges.appendChild(live); badges.appendChild(lock);
    pv.appendChild(img); pv.appendChild(ph); pv.appendChild(badges);

    var body = el('div', 'rc-body');
    var title = el('div', 'rc-title');
    var foot = el('div', 'rc-foot');
    var people = el('div', 'rc-people');
    var stack = el('div', 'rc-stack');
    var names = el('span', 'rc-names');
    people.appendChild(stack); people.appendChild(names);
    var join = el('span', 'btn btn-primary btn-sm rc-join');
    foot.appendChild(people); foot.appendChild(join);
    body.appendChild(title); body.appendChild(foot);
    card.appendChild(pv); card.appendChild(body);

    card._ui = { pv: pv, img: img, ph: ph, live: live, liveTxt: liveTxt, lock: lock, title: title, stack: stack, names: names, join: join };
    card.addEventListener('click', function () { joinRoom(card._room); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); joinRoom(card._room); }
    });
    return card;
  }

  function updateCard(card, r) {
    var u = card._ui;
    var people = r.people || [];
    card._room = r;
    card.setAttribute('aria-label', (r.private ? 'Sala privada ' : 'Sala ') + (r.name || ''));
    u.title.textContent = r.name || 'Sala';
    u.pv.classList.toggle('private', !!r.private);
    u.lock.classList.toggle('hidden', !r.private);
    u.live.classList.toggle('hidden', !r.liveBy);
    u.liveTxt.textContent = r.liveBy ? 'AO VIVO · ' + r.liveBy : '';
    u.join.textContent = r.private ? 'Entrar 🔒' : 'Entrar';

    // Prévia da tela: só sala pública com alguém ao vivo
    if (!r.private && r.liveBy && r.previewAt) {
      if (u.img._v !== r.previewAt) {
        var v = r.previewAt;
        var src = '/api/rooms?preview=1&id=' + encodeURIComponent(r.id) + '&v=' + v;
        u.img._v = v;
        var pre = new Image();
        pre.onload = function () {
          if (u.img._v !== v) return;
          u.img.src = src; u.img.classList.remove('hidden'); u.ph.classList.add('hidden');
        };
        pre.src = src;
      }
    } else {
      u.img._v = null;
      u.img.classList.add('hidden'); u.img.removeAttribute('src');
      u.ph.classList.remove('hidden');
    }

    u.ph.textContent = '';
    if (r.private) { var lk = el('span', 'rc-ph-lock'); lk.textContent = '🔒'; u.ph.appendChild(lk); }
    else people.slice(0, 5).forEach(function (p) { u.ph.appendChild(avatarEl(p)); });

    u.stack.textContent = '';
    people.slice(0, 4).forEach(function (p) { u.stack.appendChild(avatarEl(p)); });
    if (people.length > 4) { var more = el('div', 'ava more'); more.textContent = '+' + (people.length - 4); u.stack.appendChild(more); }
    var nm = people.slice(0, 3).map(function (p) { return p.name; }).join(', ');
    if (people.length > 3) nm += ' e +' + (people.length - 3);
    u.names.textContent = people.length ? nm : 'vazia';
    u.names.title = people.map(function (p) { return p.name; }).join(', ');
  }

  // =====================================================================
  // ENTRAR NA SALA
  // =====================================================================
  function enterRoom(rid, opts) {
    roomId = rid;
    myPassHash = opts.passHash || null;
    roomMeta = {
      name: (opts.name || ('Sala de ' + me.name)).slice(0, 40),
      private: !!opts.private,
      passHash: myPassHash,
      dirToken: randomChars(24)
    };
    stopLobbyPolling();
    closePass();
    try { history.replaceState(null, '', '?sala=' + roomId); } catch (e) {}

    $('lobby').classList.add('hidden');
    $('room').classList.remove('hidden');
    $('roomCodeTop').textContent = roomId;
    updateRoomHeader();
    connState('', 'conectando…');

    bindRoomUI();
    ensureAudioCtx();   // criado dentro do clique (gesto do usuário)
    setupPip();
    initVoice();
    if (opts.create) toast('Sala criada! Toque no código pra copiar o convite.', 3400);

    Promise.race([icePromise || Promise.resolve(), delay(1500)]).then(tryBecomeHost);
  }

  function updateRoomHeader() {
    $('roomTitle').textContent = roomMeta.name || 'Sala';
    $('roomLock').classList.toggle('hidden', !roomMeta.private);
    document.title = (roomMeta.private ? '🔒 ' : '') + (roomMeta.name || 'Sala');
  }

  function selfEntry() {
    return { name: me.name, avatar: me.avatar, live: !!localStream, muted: !micOn() };
  }

  // Tenta ficar com o id fixo da sala. Se já existe host, entra como membro.
  function tryBecomeHost() {
    if (leaving) return;
    cleanupPeer();
    var p = peer = new Peer(hostId(), peerOptions());
    p.on('open', function (id) {
      if (p !== peer) return;
      isHost = true; me.id = id; failedHostAttempts = 0;
      roomMeta.passHash = myPassHash;
      roster = {};
      roster[id] = selfEntry();
      setupPeerCommon(p);
      p.on('connection', handleMemberConnection);
      connState('ok', 'conectado');
      systemMessage(me.name + (everMember ? ' agora coordena a sala' : ' abriu a sala'), true);
      onRosterChanged();
      startDirectory();
    });
    p.on('error', function (err) { if (p === peer) onPeerError(err); });
  }

  function becomeMember() {
    cleanupPeer();
    isHost = false;
    stopDirectory();
    var p = peer = new Peer(undefined, peerOptions());
    p.on('open', function (id) {
      if (p !== peer) return;
      me.id = id; everMember = true;
      setupPeerCommon(p);
      connectToHost();
    });
    p.on('error', function (err) { if (p === peer) onPeerError(err); });
  }

  function connectToHost() {
    if (!peer || peer.destroyed || leaving) return;
    var conn = peer.connect(hostId(), { reliable: true });
    if (!conn) return;
    hostConn = conn;
    conn.on('open', function () {
      if (hostConn !== conn) return;
      failedHostAttempts = 0;
      connState('', 'entrando…');
      conn.send({ t: 'hello', name: me.name, avatar: me.avatar, muted: !micOn(), live: !!localStream, auth: myPassHash });
    });
    conn.on('data', function (d) { if (hostConn === conn) handleDataFromHost(d); });
    conn.on('close', function () { if (hostConn === conn) { hostConn = null; onHostLost(); } });
    conn.on('error', function () {});
  }

  function setupPeerCommon(p) {
    p.on('call', onIncomingCall);
    p.on('disconnected', function () {
      if (p === peer && !p.destroyed && !leaving) { connState('warn', 'reconectando…'); try { p.reconnect(); } catch (e) {} }
    });
    startSync();
  }

  function onPeerError(err) {
    var type = err && err.type;
    if (type === 'unavailable-id') { if (!isHost) becomeMember(); return; }
    if (type === 'peer-unavailable') return; // o loop de reconexão cuida
    if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].indexOf(type) >= 0) {
      connState('warn', 'reconectando…');
      return;
    }
    console.warn('[peer]', type, err);
    connState('warn', 'instável');
  }

  function cleanupPeer() {
    stopSync();
    var p = peer;
    peer = null; hostConn = null; memberConns = {};
    Object.keys(voiceCalls).forEach(removeVoice);
    voiceCalls = {};
    outgoingCalls = {};
    Object.keys(tiles).forEach(function (pid) { if (pid !== SELF) removeTile(pid); });
    pendingCalls = [];
    if (p) { try { p.destroy(); } catch (e) {} }
  }

  function stopReconnect() { if (reconnectTimer) clearInterval(reconnectTimer); reconnectTimer = null; }

  function onHostLost() {
    if (isHost || leaving) return;
    connState('warn', 'reconectando…');
    if (reconnectTimer) return;
    failedHostAttempts = 0;
    reconnectTimer = setInterval(function () {
      if (leaving || (hostConn && hostConn.open)) { stopReconnect(); return; }
      if (!peer || peer.destroyed) { stopReconnect(); becomeMember(); return; }
      failedHostAttempts++;
      if (failedHostAttempts >= 3) {
        // Host foi embora de vez → alguém assume (quem chegar primeiro no id)
        stopReconnect();
        toast('O host saiu — reorganizando a sala…');
        tryBecomeHost();
      } else {
        connectToHost();
      }
    }, 2500);
  }

  // =====================================================================
  // HOST: admissão e mensagens dos membros
  // =====================================================================
  function handleMemberConnection(conn) {
    conn.on('data', function (data) {
      if (!isHost || !data || !data.t) return;
      if (memberConns[conn.peer] === conn) { handleDataFromMember(conn, data); return; }
      if (data.t !== 'hello') return;

      if (roomMeta.private && data.auth !== roomMeta.passHash) {
        try { conn.send({ t: 'denied', reason: data.auth ? 'wrong' : 'required' }); } catch (e) {}
        setTimeout(function () { try { conn.close(); } catch (e) {} }, 600);
        return;
      }
      var old = memberConns[conn.peer];
      if (old && old !== conn) { try { old.close(); } catch (e) {} }
      memberConns[conn.peer] = conn;
      var isNew = !roster[conn.peer];
      roster[conn.peer] = { name: cleanName(data.name), avatar: cleanAvatar(data.avatar), live: !!data.live, muted: !!data.muted };
      if (isNew) systemMessage(roster[conn.peer].name + ' entrou', true);
      onRosterChanged();
    });
    conn.on('close', function () {
      if (memberConns[conn.peer] !== conn) return;
      delete memberConns[conn.peer];
      var gone = roster[conn.peer];
      delete roster[conn.peer];
      if (gone) systemMessage(gone.name + ' saiu', true);
      onRosterChanged();
    });
    conn.on('error', function () {});
  }

  function handleDataFromMember(conn, data) {
    var who = roster[conn.peer];
    if (!who) return;
    switch (data.t) {
      case 'chat':
        if (typeof data.text !== 'string' || !data.text.trim()) return;
        // O host carimba nome/avatar: ninguém se passa por outra pessoa
        relayChat({ t: 'chat', id: String(data.id || uid()).slice(0, 40), peerId: conn.peer, name: who.name, avatar: who.avatar, text: data.text.slice(0, 500), ts: Date.now() });
        break;
      case 'live': who.live = !!data.live; onRosterChanged(); break;
      case 'micstate': who.muted = !!data.muted; onRosterChanged(); break;
    }
  }

  function broadcastRoster() {
    broadcastToMembers({ t: 'roster', roster: roster, meta: { name: roomMeta.name, private: roomMeta.private, dirToken: roomMeta.dirToken } });
  }
  function broadcastToMembers(payload) {
    Object.keys(memberConns).forEach(function (pid) {
      var c = memberConns[pid];
      if (c && c.open) { try { c.send(payload); } catch (e) {} }
    });
  }
  function relayChat(msg) { broadcastToMembers(msg); renderChat(msg); }

  // Tudo que depende da lista de pessoas passa por aqui (host e membro)
  function onRosterChanged() {
    if (isHost && me.id) {
      roster[me.id] = selfEntry();
      broadcastRoster();
      scheduleDir();
    }
    renderPeople();
    refreshTileLabels();
    handleLiveTransitions();
    syncMedia();
  }

  // =====================================================================
  // MEMBRO: dados do host
  // =====================================================================
  function handleDataFromHost(data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case 'roster':
        roster = data.roster || {};
        if (data.meta) {
          roomMeta.name = String(data.meta.name || roomMeta.name).slice(0, 40);
          roomMeta.private = !!data.meta.private;
          if (data.meta.dirToken) roomMeta.dirToken = String(data.meta.dirToken);
          updateRoomHeader();
        }
        connState('ok', 'conectado');
        onRosterChanged();
        break;
      case 'chat':
      case 'system':
        renderChat(data);
        break;
      case 'denied':
        onDenied(data.reason);
        break;
    }
  }

  function onDenied(reason) {
    leaving = true;
    stopEverything();
    location.replace(location.pathname + '?sala=' + roomId + '&auth=' + (reason === 'wrong' ? 'wrong' : 'required'));
  }

  // =====================================================================
  // CONEXÕES DE MÍDIA
  // =====================================================================
  function admitted(pid) { return pid === hostId() || !!roster[pid]; }
  function safeClose(c) { try { if (c) c.close(); } catch (e) {} }
  function stamp(c) { c._t0 = Date.now(); return c; }
  function callState(c) {
    var pc = c && c.peerConnection;
    return pc ? (pc.connectionState || pc.iceConnectionState || 'new') : 'new';
  }
  function isDead(c) {
    var s = callState(c), now = Date.now();
    if (s === 'connected' || s === 'completed') { c._ok = now; return false; }
    if (s === 'failed' || s === 'closed') return true;
    return now - (c._ok || c._t0 || now) > CALL_TIMEOUT;
  }

  // Só atende quem foi admitido. Quem ainda não aparece no roster espera um pouco
  // (o roster pode chegar logo depois da chamada).
  function onIncomingCall(call) {
    if (leaving) { safeClose(call); return; }
    if (admitted(call.peer)) { routeCall(call); return; }
    pendingCalls.push({ call: call, t: Date.now() });
  }
  function processPendingCalls() {
    var now = Date.now();
    pendingCalls = pendingCalls.filter(function (p) {
      if (admitted(p.call.peer)) { routeCall(p.call); return false; }
      if (now - p.t > PENDING_TIMEOUT) { safeClose(p.call); return false; }
      return true;
    });
  }
  function routeCall(call) {
    if (call.metadata && call.metadata.kind === 'voice') handleIncomingVoice(call);
    else handleIncomingScreen(call);
  }

  // Revisão de todas as conexões. Roda a cada mudança no roster e a cada 4s:
  // é isso que garante que quem entra depois recebe a tela de quem já está ao vivo.
  function syncMedia() {
    if (!peer || peer.destroyed || !me.id || leaving) return;
    processPendingCalls();
    var others = Object.keys(roster).filter(function (p) { return p !== me.id; });

    // Limpa quem saiu
    Object.keys(voiceCalls).forEach(function (pid) {
      if (roster[pid]) return;
      var c = voiceCalls[pid]; delete voiceCalls[pid]; safeClose(c); removeVoice(pid);
    });
    Object.keys(outgoingCalls).forEach(function (pid) {
      if (roster[pid] && localStream) return;
      var c = outgoingCalls[pid]; delete outgoingCalls[pid]; safeClose(c);
    });
    Object.keys(tiles).forEach(function (pid) { if (pid !== SELF && !roster[pid]) removeTile(pid); });

    // Voz: em cada par, quem tem o id "maior" liga — nunca duplica
    if (sendStream) {
      others.forEach(function (pid) {
        if (me.id < pid) return;
        var c = voiceCalls[pid];
        if (c && !isDead(c)) return;
        if (c) { delete voiceCalls[pid]; safeClose(c); }
        startVoiceCall(pid);
      });
    }

    // Tela: quem transmite liga pra todo mundo que ainda não está recebendo
    if (localStream) {
      others.forEach(function (pid) {
        var c = outgoingCalls[pid];
        if (c && !isDead(c)) return;
        if (c) { delete outgoingCalls[pid]; safeClose(c); }
        callScreen(pid);
      });
    }
  }
  function startSync() { stopSync(); syncTimer = setInterval(syncMedia, SYNC_EVERY); }
  function stopSync() { if (syncTimer) clearInterval(syncTimer); syncTimer = null; }

  // ---------- voz ----------
  function startVoiceCall(pid) {
    if (!peer || !sendStream) return;
    var call = peer.call(pid, sendStream, { metadata: { kind: 'voice' } });
    if (!call) return;
    stamp(call);
    voiceCalls[pid] = call;
    bindVoiceCall(pid, call);
  }
  function handleIncomingVoice(call) {
    var pid = call.peer;
    var old = voiceCalls[pid];
    if (old && old !== call) { delete voiceCalls[pid]; safeClose(old); }
    call.answer(sendStream || undefined);
    stamp(call);
    voiceCalls[pid] = call;
    bindVoiceCall(pid, call);
    setTimeout(function () { if (voiceCalls[pid] === call) replaceAudio(call, sendTrack); }, 0);
  }
  function bindVoiceCall(pid, call) {
    call.on('stream', function (s) { if (voiceCalls[pid] === call) setRemoteVoice(pid, s); });
    var end = function () { if (voiceCalls[pid] === call) { delete voiceCalls[pid]; removeVoice(pid); } };
    call.on('close', end);
    call.on('error', end);
  }

  function replaceAudio(call, track) {
    var pc = call && call.peerConnection;
    if (!pc || !track || !pc.getTransceivers) return;
    pc.getTransceivers().forEach(function (t) {
      if (!t.sender || t.stopped) return;
      var kind = t.sender.track ? t.sender.track.kind : (t.receiver && t.receiver.track && t.receiver.track.kind);
      if (kind === 'audio' && t.sender.track !== track) t.sender.replaceTrack(track).catch(function () {});
    });
  }
  function applySendTrack() {
    Object.keys(voiceCalls).forEach(function (pid) { replaceAudio(voiceCalls[pid], sendTrack); });
  }

  function setRemoteVoice(pid, stream) {
    var a = voiceAudios[pid];
    if (!a) {
      a = new Audio(); a.autoplay = true;
      $('audioSink').appendChild(a);
      voiceAudios[pid] = a;
    }
    a.srcObject = stream;
    if (selectedOutputId && a.setSinkId) a.setSinkId(selectedOutputId).catch(function () {});
    var pr = a.play();
    if (pr && pr.catch) pr.catch(function () { lockAudio(); });
    addAnalyser(pid, stream);
  }
  function removeVoice(pid) {
    var a = voiceAudios[pid];
    if (a) { try { a.srcObject = null; } catch (e) {} if (a.parentNode) a.parentNode.removeChild(a); delete voiceAudios[pid]; }
    removeAnalyser(pid);
    setSpeaking(pid, false);
  }

  // Navegador bloqueou o autoplay com som → destrava no próximo clique
  function lockAudio() {
    if (audioLocked) return;
    audioLocked = true;
    toast('Clique em qualquer lugar pra ativar o som 🔊', 6000);
  }
  function unlockAudio() {
    audioLocked = false;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    Object.keys(voiceAudios).forEach(function (pid) { var a = voiceAudios[pid]; if (a.paused) a.play().catch(function () {}); });
    Object.keys(tiles).forEach(function (pid) { playTile(tiles[pid]); });
  }

  // ---------- tela ----------
  function callScreen(pid) {
    if (!peer || !localStream) return;
    var call = peer.call(pid, localStream, { metadata: { kind: 'screen' } });
    if (!call) return;
    stamp(call);
    outgoingCalls[pid] = call;
    var end = function () { if (outgoingCalls[pid] === call) delete outgoingCalls[pid]; };
    call.on('close', end);
    call.on('error', end);
  }
  function handleIncomingScreen(call) {
    var pid = call.peer;
    call.answer();
    stamp(call);
    call.on('stream', function (s) { addTile(pid, s, call); });
    var end = function () { var t = tiles[pid]; if (t && t.call === call) removeTile(pid); };
    call.on('close', end);
    call.on('error', end);
  }

  // Quem parou de transmitir some do palco (o "close" do WebRTC nem sempre chega)
  function handleLiveTransitions() {
    Object.keys(roster).forEach(function (pid) {
      var live = !!roster[pid].live;
      if (prevLive[pid] && !live && pid !== me.id) removeTile(pid);
      prevLive[pid] = live;
    });
    Object.keys(prevLive).forEach(function (pid) { if (!roster[pid]) delete prevLive[pid]; });
  }

  // =====================================================================
  // UI da sala
  // =====================================================================
  function bindRoomUI() {
    if (roomUiBound) return;
    roomUiBound = true;

    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chatInput'); var text = input.value.trim();
      if (!text) return;
      input.value = ''; sendChat(text);
    });
    $('shareBtn').addEventListener('click', function () { if (localStream) stopSharing(); else startSharing(); });
    $('leaveBtn').addEventListener('click', leaveRoom);
    $('copyLinkBtn').addEventListener('click', copyInvite);
    $('sidebarToggle').addEventListener('click', function () { $('sidebar').classList.toggle('collapsed'); });
    $('micBtn').addEventListener('click', onMicBtn);
    $('pipBtn').addEventListener('click', togglePip);

    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', closeSettings);
    $('settingsOverlay').addEventListener('click', function (e) { if (e.target === $('settingsOverlay')) closeSettings(); });
    $('micSelect').addEventListener('change', function () {
      selectedMicId = this.value || null; pref('micId', selectedMicId);
      rebuildMic();
    });
    $('outputSelect').addEventListener('change', function () {
      selectedOutputId = this.value || null; pref('outId', selectedOutputId);
      applyOutputToAll(); toast('Saída de áudio atualizada');
    });
    $('testSoundBtn').addEventListener('click', function () { playTestTone(selectedOutputId); });
    $('themeDark').addEventListener('click', function () { setTheme('dark'); });
    $('themeLight').addEventListener('click', function () { setTheme('light'); });
    Array.prototype.forEach.call(document.querySelectorAll('#nsSeg .seg-btn'), function (b) {
      b.addEventListener('click', function () { setNoiseMode(b.getAttribute('data-ns')); });
    });
    $('loopbackToggle').addEventListener('change', function () { if (this.checked) startLoopback(); else stopLoopback(); });

    document.addEventListener('pointerdown', function () { if (audioLocked) unlockAudio(); }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (settingsOpen) closeSettings();
    });

    updateMicBtn();
  }

  // =====================================================================
  // CHAT
  // =====================================================================
  function sendChat(text) {
    var msg = { t: 'chat', id: uid(), peerId: me.id, name: me.name, avatar: me.avatar, text: text, ts: Date.now() };
    renderChat(msg); // otimista; o eco do host é ignorado pelo id
    if (isHost) broadcastToMembers(msg);
    else if (hostConn && hostConn.open) hostConn.send(msg);
    else toast('Sem conexão com a sala…');
  }
  function systemMessage(text, broadcast) {
    var msg = { t: 'system', id: uid(), text: text, ts: Date.now() };
    renderChat(msg);
    if (broadcast && isHost) broadcastToMembers(msg);
  }
  function renderChat(msg) {
    if (!msg) return;
    if (!msg.id) msg.id = uid();
    if (seenMsgIds[msg.id]) return;
    seenMsgIds[msg.id] = 1;
    var log = $('chatLog');
    var row = el('div', 'chat-msg' + (msg.t === 'system' ? ' system' : ''));
    if (msg.t === 'system') {
      var st = el('div', 'chat-text'); st.textContent = msg.text; row.appendChild(st);
    } else {
      var body = el('div', 'chat-body');
      var meta = el('div', 'chat-meta');
      var author = el('span', 'chat-author'); author.textContent = msg.name || 'Anônimo';
      var time = el('span', 'chat-time'); time.textContent = formatTime(msg.ts);
      meta.appendChild(author); meta.appendChild(time);
      var txt = el('div', 'chat-text'); txt.textContent = msg.text;
      body.appendChild(meta); body.appendChild(txt);
      row.appendChild(avatarEl({ avatar: msg.avatar, name: msg.name || msg.peerId })); row.appendChild(body);
    }
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.appendChild(row);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function formatTime(ts) {
    var d = new Date(ts || Date.now());
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // =====================================================================
  // LISTA DE PESSOAS
  // =====================================================================
  function speakingOf(pid) { return pid === me.id ? !!speakingState[LOCAL] : !!speakingState[pid]; }

  function renderPeople() {
    var list = $('peopleList');
    list.innerHTML = '';
    peopleAvatarEls = {};
    var ids = Object.keys(roster);
    $('peopleCount').textContent = ids.length;
    ids.forEach(function (pid) {
      var p = roster[pid];
      var li = el('li', 'person');
      var ava = avatarEl(p);
      if (speakingOf(pid)) ava.classList.add('speaking');
      peopleAvatarEls[pid] = ava;
      var name = el('span', 'p-name'); name.textContent = p.name || 'Anônimo';
      li.appendChild(ava); li.appendChild(name);
      if (pid === me.id) { var you = el('span', 'you-tag'); you.textContent = 'você'; li.appendChild(you); }
      if (p.muted) {
        var m = el('span', 'p-muted'); m.title = 'Microfone desligado';
        m.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
        li.appendChild(m);
      }
      if (p.live) {
        var live = el('span', 'p-live'); live.appendChild(el('span', 'live-dot'));
        live.appendChild(document.createTextNode('ao vivo')); li.appendChild(live);
      }
      list.appendChild(li);
    });
  }

  // =====================================================================
  // MICROFONE + SUPRESSÃO DE RUÍDO
  // =====================================================================
  function ensureAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); }
      catch (e) { audioCtx = new AC(); }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function micOn() { return micEnabled && !!micPipe; }

  function initVoice() {
    var ctx = ensureAudioCtx();
    if (ctx && !silentStream) {
      try { silentStream = ctx.createMediaStreamDestination().stream; } catch (e) {}
    }
    // Áudio mudo até o mic ficar pronto: assim as chamadas de voz já podem começar
    if (!sendStream && silentStream) { sendStream = silentStream; sendTrack = silentStream.getAudioTracks()[0]; }
    updateNsUI();
    rebuildMic();
  }

  function rebuildMic() {
    var seq = ++micBuildSeq;
    setNsStatus('loading');
    if (!window.SalaNoise || !audioCtx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setNsStatus('error'); updateMicBtn(); return;
    }
    var wantsAi = noiseMode === 'gtcrn' || noiseMode === 'rnnoise';
    var mode = aiFailed && wantsAi ? 'browser' : noiseMode;
    var onFail = function () {
      if (seq !== micBuildSeq || aiFailed) return;
      aiFailed = true;
      toast('A IA de ruído parou — trocando pra supressão do navegador.', 3600);
      rebuildMic();
    };
    SalaNoise.create(audioCtx, { mode: mode, deviceId: selectedMicId, onFail: onFail }).then(function (pipe) {
      if (seq !== micBuildSeq || leaving) { pipe.dispose(); return; }
      var old = micPipe;
      micPipe = pipe;
      sendStream = pipe.stream;
      sendTrack = pipe.track;
      sendTrack.enabled = micEnabled;
      applySendTrack();
      addAnalyser(LOCAL, pipe.stream);
      if (loopAudio) startLoopback();
      if (old) old.dispose();
      setNsStatus(pipe.engine, pipe.fallback || (wantsAi && pipe.engine === 'browser'));
      updateMicBtn();
      broadcastMicState();
      if (settingsOpen) populateDevices();
    }).catch(function (err) {
      if (seq !== micBuildSeq) return;
      console.warn('[mic]', err && err.name, err);
      setNsStatus('error');
      if (err && err.name === 'NotAllowedError') toast('Microfone bloqueado — libere no navegador pra falar.', 3600);
      else if (err && err.name === 'NotFoundError') toast('Nenhum microfone encontrado.');
      updateMicBtn();
      broadcastMicState();
    });
  }

  function onMicBtn() {
    if (!micPipe) { rebuildMic(); return; }
    micEnabled = !micEnabled;
    if (sendTrack) sendTrack.enabled = micEnabled;
    updateMicBtn();
    broadcastMicState();
  }

  function broadcastMicState() {
    if (!me.id) return;
    if (isHost) onRosterChanged();
    else if (hostConn && hostConn.open) hostConn.send({ t: 'micstate', muted: !micOn() });
  }

  function updateMicBtn() {
    var on = micOn();
    $('iconMicOn').classList.toggle('hidden', !on);
    $('iconMicOff').classList.toggle('hidden', on);
    $('micBtn').classList.toggle('muted', !on);
    $('micBtnLabel').textContent = on ? 'Microfone' : (micPipe ? 'Mudo' : 'Ativar mic');
  }

  function setNoiseMode(mode) {
    if (!NS_HINTS[mode] || (mode === noiseMode && !aiFailed)) return;
    noiseMode = mode;
    aiFailed = false; // escolha explícita: tenta de novo
    pref('noise', mode);
    updateNsUI();
    rebuildMic();
  }
  function updateNsUI() {
    Array.prototype.forEach.call(document.querySelectorAll('#nsSeg .seg-btn'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-ns') === noiseMode);
    });
    var hint = NS_HINTS[noiseMode];
    if (noiseMode === 'browser' && navigator.mediaDevices && navigator.mediaDevices.getSupportedConstraints &&
        navigator.mediaDevices.getSupportedConstraints().voiceIsolation) {
      hint = 'Supressão nativa do navegador (WebRTC) + isolamento de voz do sistema.';
    }
    $('nsHint').textContent = hint;
  }
  function setNsStatus(state, fallback) {
    var s = $('nsStatus');
    var map = {
      loading: ['', 'Carregando…'],
      gtcrn: ['ok', '✓ Ativo: IA GTCRN'],
      rnnoise: ['ok', '✓ Ativo: IA RNNoise'],
      browser: fallback ? ['warn', '⚠ A IA não carregou aqui — usando a supressão do navegador'] : ['ok', '✓ Ativo: supressão do navegador'],
      off: ['', 'Filtro desligado'],
      error: ['warn', '⚠ Microfone indisponível']
    };
    var v = map[state] || map.error;
    s.className = 'ns-status' + (v[0] ? ' ' + v[0] : '');
    s.textContent = v[1];
  }

  // ---------- ouvir o próprio microfone (teste) ----------
  function startLoopback() {
    stopLoopback(true);
    if (!micPipe) { toast('Microfone indisponível'); $('loopbackToggle').checked = false; return; }
    loopAudio = new Audio();
    loopAudio.srcObject = micPipe.stream;
    if (selectedOutputId && loopAudio.setSinkId) loopAudio.setSinkId(selectedOutputId).catch(function () {});
    loopAudio.play().catch(function () {});
  }
  function stopLoopback(keepCheckbox) {
    if (loopAudio) { try { loopAudio.pause(); loopAudio.srcObject = null; } catch (e) {} loopAudio = null; }
    if (!keepCheckbox) $('loopbackToggle').checked = false;
  }

  // =====================================================================
  // DETECTOR DE FALA — um único loop pra todos
  // =====================================================================
  function addAnalyser(key, stream) {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      removeAnalyser(key);
      var src = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.4;
      src.connect(analyser);
      analysers[key] = { src: src, analyser: analyser, data: new Uint8Array(analyser.fftSize), last: 0 };
      if (!vadRunning) { vadRunning = true; requestAnimationFrame(vadLoop); }
    } catch (e) {}
  }
  function removeAnalyser(key) {
    if (analysers[key]) { try { analysers[key].src.disconnect(); } catch (e) {} delete analysers[key]; }
  }
  function vadLoop() {
    var now = performance.now();
    Object.keys(analysers).forEach(function (key) {
      var a = analysers[key];
      a.analyser.getByteTimeDomainData(a.data);
      var sum = 0;
      for (var i = 0; i < a.data.length; i++) { var x = (a.data[i] - 128) / 128; sum += x * x; }
      var rms = Math.sqrt(sum / a.data.length);
      var isMe = key === LOCAL;
      if (isMe) localMicLevel = micEnabled ? Math.min(1, rms / 0.25) : 0;
      if (rms > SPEAK_THRESHOLD && (!isMe || micEnabled)) a.last = now;
      var on = (now - a.last) < SPEAK_HANGOVER;
      if (on !== !!speakingState[key]) setSpeaking(key, on);
    });
    if (settingsOpen) $('micMeterFill').style.width = Math.round(localMicLevel * 100) + '%';
    if (pipActive) drawPip();
    requestAnimationFrame(vadLoop);
  }
  function setSpeaking(key, on) {
    speakingState[key] = on;
    var pid = key === LOCAL ? me.id : key;
    var av = pid && peopleAvatarEls[pid];
    if (av) av.classList.toggle('speaking', on);
    var t = tiles[key === LOCAL ? SELF : key];
    if (t) t.tile.classList.toggle('speaking', on);
  }

  // =====================================================================
  // TRANSMISSÃO DE TELA
  // =====================================================================
  function startSharing() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('Seu navegador não suporta compartilhar tela.'); return; }
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude'
    }).then(function (stream) {
      localStream = stream;
      setShareButton(true);
      addTile(SELF, stream, null);
      var vt = stream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', stopSharing);
      setLive();
      syncMedia(); // liga pra todo mundo agora
    }).catch(function (err) {
      if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Não foi possível compartilhar: ' + (err.name || err));
    });
  }

  function stopSharing() {
    if (!localStream) return;
    localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    localStream = null;
    Object.keys(outgoingCalls).forEach(function (pid) { safeClose(outgoingCalls[pid]); });
    outgoingCalls = {};
    removeTile(SELF);
    setShareButton(false);
    setLive();
  }

  function setLive() {
    if (!me.id) return;
    if (isHost) onRosterChanged();
    else if (hostConn && hostConn.open) hostConn.send({ t: 'live', live: !!localStream });
  }

  function setShareButton(on) {
    $('shareBtn').classList.toggle('is-live', on);
    $('shareBtnLabel').textContent = on ? 'Parar transmissão' : 'Transmitir tela';
  }

  // =====================================================================
  // TILES DE VÍDEO
  // =====================================================================
  function tileInfo(pid) {
    if (pid === SELF || pid === me.id) return { name: me.name + ' (você)', avatar: me.avatar, seed: me.name };
    var r = roster[pid] || { name: 'Alguém', avatar: '❓' };
    return { name: r.name, avatar: r.avatar, seed: r.name };
  }

  function addTile(pid, stream, call) {
    var t = tiles[pid];
    if (t) {
      t.call = call || t.call;
      if (t.video.srcObject !== stream) { t.video.srcObject = stream; playTile(t); }
      return;
    }
    var isSelf = pid === SELF;
    var tile = el('div', 'video-tile' + (isSelf ? ' self' : ''));
    if (speakingState[isSelf ? LOCAL : pid]) tile.classList.add('speaking');

    var video = el('video');
    video.autoplay = true; video.playsInline = true;
    video.muted = isSelf; // não toco o áudio da minha própria tela
    video.srcObject = stream;
    if (!isSelf && selectedOutputId && video.setSinkId) video.setSinkId(selectedOutputId).catch(function () {});

    var info = tileInfo(pid);
    var label = el('div', 'tile-label');
    var mini = el('div', 'mini-ava'); mini.textContent = info.avatar; mini.style.background = avatarStyle(info.seed);
    var nameSpan = el('span'); nameSpan.textContent = info.name;
    label.appendChild(mini); label.appendChild(el('span', 'live-dot')); label.appendChild(nameSpan);

    tile.appendChild(video); tile.appendChild(label);
    $('videoGrid').appendChild(tile);
    tiles[pid] = { tile: tile, video: video, call: call, nameSpan: nameSpan, mini: mini, overlay: null };
    playTile(tiles[pid]);
    refreshStage();
  }

  // Se o navegador bloquear o autoplay, mostra um botão em vez de tela preta
  function playTile(t) {
    if (!t || !t.video.paused) return;
    var pr = t.video.play();
    if (pr && pr.then) {
      pr.then(function () { if (t.overlay) { t.overlay.remove(); t.overlay = null; } })
        .catch(function () { showPlayOverlay(t); });
    }
  }
  function showPlayOverlay(t) {
    if (t.overlay || !t.tile.parentNode) return;
    var o = el('button', 'tile-play');
    var s = el('span'); s.textContent = '▶ Clique para assistir';
    o.appendChild(s);
    o.addEventListener('click', function () { unlockAudio(); playTile(t); });
    t.tile.appendChild(o);
    t.overlay = o;
  }

  function removeTile(pid) {
    var t = tiles[pid];
    if (!t) return;
    try { t.video.srcObject = null; } catch (e) {}
    if (t.tile.parentNode) t.tile.parentNode.removeChild(t.tile);
    delete tiles[pid];
    refreshStage();
  }

  function refreshTileLabels() {
    Object.keys(tiles).forEach(function (pid) {
      var t = tiles[pid], info = tileInfo(pid);
      t.nameSpan.textContent = info.name;
      t.mini.textContent = info.avatar;
      t.mini.style.background = avatarStyle(info.seed);
    });
  }

  function refreshStage() {
    var count = Object.keys(tiles).length;
    $('emptyStage').style.display = count ? 'none' : '';
    $('videoGrid').classList.toggle('multi', count > 1);
  }

  // =====================================================================
  // DIRETÓRIO (host mantém a sala na lista)
  // =====================================================================
  function startDirectory() {
    stopDirectory();
    pushDir();
    dirTimer = setInterval(pushDir, DIR_HEARTBEAT);
  }
  function stopDirectory() {
    if (dirTimer) clearInterval(dirTimer);
    dirTimer = null;
    clearTimeout(dirDebounce);
  }
  function scheduleDir() {
    if (!isHost) return;
    clearTimeout(dirDebounce);
    dirDebounce = setTimeout(pushDir, 700);
  }
  function pushDir() {
    if (!isHost || leaving || !roomMeta.dirToken) return;
    var ids = Object.keys(roster);
    var liveBy = null;
    ids.some(function (pid) { if (roster[pid].live) { liveBy = roster[pid].name; return true; } return false; });
    var body = {
      id: roomId,
      token: roomMeta.dirToken,
      name: roomMeta.name,
      private: roomMeta.private,
      people: ids.map(function (pid) { var p = roster[pid]; return { name: p.name, avatar: p.avatar, live: !!p.live, muted: !!p.muted }; }),
      liveBy: liveBy
    };
    if (!roomMeta.private && liveBy) { var shot = capturePreview(); if (shot) body.preview = shot; }
    fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(function () {});
  }
  function leaveDirectory() {
    if (!isHost || !roomMeta.dirToken) return;
    // Se ainda tem gente, alguém assume e mantém a sala na lista (mesmo token)
    if (Object.keys(roster).length > 1) return;
    try {
      var data = JSON.stringify({ id: roomId, token: roomMeta.dirToken });
      navigator.sendBeacon('/api/rooms?action=leave', new Blob([data], { type: 'application/json' }));
    } catch (e) {}
  }

  // Foto pequena da tela que está no palco, pra prévia no lobby
  function capturePreview() {
    var pick = null;
    Object.keys(tiles).some(function (pid) {
      var t = tiles[pid];
      if (pid !== SELF && t.video.videoWidth) { pick = t; return true; }
      return false;
    });
    if (!pick && tiles[SELF] && tiles[SELF].video.videoWidth) pick = tiles[SELF];
    if (!pick) return null;
    var v = pick.video, cv = $('previewCanvas'), ctx = cv.getContext('2d');
    var W = cv.width = 400, H = cv.height = 225;
    var s = Math.min(W / v.videoWidth, H / v.videoHeight);
    var w = v.videoWidth * s, h = v.videoHeight * s;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    try {
      ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
      return cv.toDataURL('image/jpeg', 0.62);
    } catch (e) { return null; }
  }

  // =====================================================================
  // CONFIGURAÇÕES
  // =====================================================================
  function openSettings() {
    settingsOpen = true;
    $('settingsOverlay').classList.remove('hidden');
    updateThemeUI();
    updateNsUI();
    populateDevices();
  }
  function closeSettings() {
    settingsOpen = false;
    $('settingsOverlay').classList.add('hidden');
    stopLoopback();
  }

  function populateDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var mics = devices.filter(function (d) { return d.kind === 'audioinput'; });
      var outs = devices.filter(function (d) { return d.kind === 'audiooutput'; });

      var micSel = $('micSelect');
      micSel.innerHTML = '';
      if (!mics.length) {
        var o0 = document.createElement('option'); o0.textContent = 'Nenhum microfone'; micSel.appendChild(o0);
        micSel.disabled = true;
      } else {
        micSel.disabled = false;
        mics.forEach(function (d, i) {
          var o = document.createElement('option'); o.value = d.deviceId;
          o.textContent = d.label || ('Microfone ' + (i + 1));
          micSel.appendChild(o);
        });
        var cur = selectedMicId;
        if (!cur && micPipe && micPipe.track && micPipe.track.getSettings) cur = micPipe.track.getSettings().deviceId;
        if (cur) micSel.value = cur;
      }

      var outSel = $('outputSelect'), hint = $('outputHint');
      var supportsSink = 'setSinkId' in HTMLMediaElement.prototype;
      outSel.innerHTML = '';
      if (!supportsSink || !outs.length) {
        var o1 = document.createElement('option'); o1.textContent = 'Padrão do sistema'; outSel.appendChild(o1);
        outSel.disabled = true;
        hint.textContent = supportsSink ? 'Nenhuma saída extra encontrada.' : 'Seu navegador escolhe a saída (use Chrome/Edge pra trocar).';
      } else {
        outSel.disabled = false;
        outs.forEach(function (d, i) {
          var o = document.createElement('option'); o.value = d.deviceId;
          o.textContent = d.label || ('Saída ' + (i + 1));
          outSel.appendChild(o);
        });
        if (selectedOutputId) outSel.value = selectedOutputId;
        hint.textContent = 'Toca um bip na saída escolhida.';
      }
    }).catch(function () {});
  }

  function applyOutputToAll() {
    if (!('setSinkId' in HTMLMediaElement.prototype) || !selectedOutputId) return;
    var set = function (m) { if (m && m.setSinkId) m.setSinkId(selectedOutputId).catch(function () {}); };
    Object.keys(voiceAudios).forEach(function (pid) { set(voiceAudios[pid]); });
    Object.keys(tiles).forEach(function (pid) { if (pid !== SELF) set(tiles[pid].video); });
    set(loopAudio);
  }

  function playTestTone(deviceId) {
    var ctx = ensureAudioCtx();
    if (!ctx) { toast('Não consegui tocar o som de teste.'); return; }
    try {
      var dest = ctx.createMediaStreamDestination();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 528;
      osc.connect(gain); gain.connect(dest);
      var a = new Audio(); a.srcObject = dest.stream;
      var start = function () {
        a.play().catch(function () {});
        var t0 = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.28, t0 + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
        osc.start(t0); osc.stop(t0 + 0.6);
        setTimeout(function () { try { a.srcObject = null; } catch (e) {} }, 900);
      };
      if (deviceId && a.setSinkId) a.setSinkId(deviceId).then(start).catch(start); else start();
    } catch (e) { toast('Não consegui tocar o som de teste.'); }
  }

  // =====================================================================
  // PICTURE-IN-PICTURE (canvas com avatares + quem está falando)
  // =====================================================================
  function setupPip() {
    if (pipCanvas) return;
    pipCanvas = $('pipCanvas'); pipVideo = $('pipVideo');
    pipCtx = pipCanvas.getContext('2d');
    drawPip();
    try {
      // O vídeo já fica tocando: o pedido de PiP vira uma chamada direta no clique
      pipVideo.srcObject = pipCanvas.captureStream(15);
      pipVideo.play().catch(function () {});
    } catch (e) {}
    pipVideo.addEventListener('leavepictureinpicture', function () { pipActive = false; $('pipBtn').classList.remove('active'); });
    pipVideo.addEventListener('enterpictureinpicture', function () { pipActive = true; $('pipBtn').classList.add('active'); });
  }

  function togglePip() {
    if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(function () {}); return; }
    if (!document.pictureInPictureEnabled) { toast('Seu navegador não suporta janela flutuante (PiP).'); return; }
    pipActive = true; drawPip();
    var go = function () {
      pipVideo.requestPictureInPicture().then(function () {
        $('pipBtn').classList.add('active');
        toast('Janela flutuante ligada — mostra quem está falando fora da aba 👀', 3200);
      }).catch(function () { pipActive = false; toast('Não consegui abrir a janela flutuante.'); });
    };
    if (pipVideo.readyState >= 2) go();
    else { pipVideo.play().catch(function () {}); pipVideo.addEventListener('loadeddata', go, { once: true }); }
  }

  function pipTruncate(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawPip() {
    if (!pipCtx) return;
    var ctx = pipCtx, W = pipCanvas.width, H = pipCanvas.height;
    ctx.fillStyle = '#14161d'; ctx.fillRect(0, 0, W, H);
    var ids = Object.keys(roster);
    if (!ids.length && me.id) ids = [me.id];
    var n = ids.length || 1;
    var cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    var rows = Math.ceil(n / cols);
    var cw = W / cols, ch = H / rows;
    ids.forEach(function (pid, idx) {
      var cx = (idx % cols) * cw + cw / 2;
      var cy = Math.floor(idx / cols) * ch + ch / 2 - 6;
      var r = Math.min(cw, ch) * 0.24;
      var info = roster[pid] || { name: me.name, avatar: me.avatar };
      if (speakingOf(pid)) {
        ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#3ddc84'; ctx.lineWidth = 4; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = avatarColor(info.name || pid); ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = Math.round(r * 1.15) + 'px sans-serif';
      ctx.fillText(info.avatar || '❓', cx, cy + 2);
      if (info.muted) { ctx.font = Math.round(r * 0.55) + 'px sans-serif'; ctx.fillText('🔇', cx + r * 0.7, cy - r * 0.7); }
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
      ctx.font = '600 ' + Math.max(11, Math.round(r * 0.42)) + 'px Inter, sans-serif';
      ctx.fillText(pipTruncate(ctx, (info.name || '') + (pid === me.id ? ' (você)' : ''), cw - 8), cx, cy + r + 7);
    });
  }

  // =====================================================================
  // SAIR
  // =====================================================================
  function copyInvite() {
    var url = inviteUrl();
    var extra = roomMeta.private ? ' (lembre de mandar a senha também 🔒)' : '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url)
        .then(function () { toast('Link copiado! Manda pros amigos 🎉' + extra, 3200); })
        .catch(function () { window.prompt('Copie o link da sala:', url); });
    } else window.prompt('Copie o link da sala:', url);
  }

  function stopEverything() {
    stopReconnect();
    stopDirectory();
    if (localStream) localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    localStream = null;
    if (micPipe) { micPipe.dispose(); micPipe = null; }
    stopLoopback(true);
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
    cleanupPeer();
  }

  function leaveRoom() {
    if (!window.confirm('Sair da sala?')) return;
    leaving = true;
    leaveDirectory();
    stopEverything();
    location.href = location.pathname;
  }

  window.addEventListener('pagehide', function () {
    if (!roomId || leaving) return;
    leaving = true;
    leaveDirectory();
    stopEverything();
  });

  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof Peer === 'undefined') toast('Falha ao carregar o motor de conexão (PeerJS).', 6000);
    initLobby();
  });
})();
