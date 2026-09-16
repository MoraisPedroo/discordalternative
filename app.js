/* =========================================================================
   Sala — voz + transmissão de tela P2P + chat, 100% no navegador.
   Sinalização/presença via PeerJS (broker gratuito). Áudio e vídeo vão P2P.
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

  var PEER_CONFIG = {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ]
    }
  };

  var HOST_PREFIX = 'dalt-';
  var SPEAK_THRESHOLD = 0.055; // RMS mínimo pra considerar "falando"
  var SPEAK_HANGOVER = 240;    // ms que o anel verde permanece após parar

  // ---------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------
  var me = { name: '', avatar: '', id: null };
  var roomId = null;
  var isHost = false;

  var peer = null;
  var hostConn = null;
  var memberConns = {};
  var roster = {};              // peerId -> { name, avatar, live, muted }
  var outgoingCalls = {};       // tela: peerId -> MediaConnection
  var incomingTiles = {};       // peerId -> { tile, video, ... }
  var localStream = null;       // tela (screen share)

  // Voz
  var micStream = null, micTrack = null, micEnabled = true;
  var voiceCalls = {};          // peerId -> MediaConnection (voz)
  var voiceAudios = {};         // peerId -> <audio>
  var voiceSwept = false;
  var selectedMicId = null, selectedOutputId = null;

  // VAD / fala
  var audioCtx = null;
  var analysers = {};           // peerId -> { src, analyser, data, last }
  var speakingState = {};
  var peopleAvatarEls = {};
  var localMicLevel = 0;
  var vadRunning = false;

  // PiP
  var pipActive = false, pipCanvas = null, pipCtx = null, pipVideo = null, pipStream = null;

  var settingsOpen = false;
  var seenMsgIds = {};
  var reconnectTimer = null;
  var failedHostAttempts = 0;
  var joined = false;

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
  function hashStr(s) { var h = 0; for (var i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return Math.abs(h); }
  function avatarStyle(seed) {
    var h = hashStr(seed || 'x') % 360;
    return 'linear-gradient(135deg, hsl(' + h + ',70%,55%), hsl(' + ((h + 40) % 360) + ',70%,45%))';
  }
  function avatarColor(seed) { return 'hsl(' + (hashStr(seed || 'x') % 360) + ',66%,52%)'; }
  function genCode() {
    var s = Math.random().toString(36).replace(/[^a-z0-9]/g, '');
    while (s.length < 6) s += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
    return s.slice(0, 6);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function inviteUrl() { return location.origin + location.pathname + '?sala=' + roomId; }

  // =====================================================================
  // TEMA
  // =====================================================================
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('sala.theme', t); } catch (e) {}
    updateThemeUI(t);
  }
  function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
  function updateThemeUI(t) {
    var moon = $('iconMoon'), sun = $('iconSun');
    if (moon && sun) { moon.classList.toggle('hidden', t !== 'dark'); sun.classList.toggle('hidden', t === 'dark'); }
    var d = $('themeDark'), l = $('themeLight');
    if (d && l) { d.classList.toggle('active', t === 'dark'); l.classList.toggle('active', t === 'light'); }
  }

  // =====================================================================
  // LOBBY
  // =====================================================================
  var pendingRoomId = null;

  function initLobby() {
    updateThemeUI(currentTheme());
    try {
      selectedMicId = localStorage.getItem('sala.micId') || null;
      selectedOutputId = localStorage.getItem('sala.outId') || null;
    } catch (e) {}

    var grid = $('avatarGrid');
    AVATARS.forEach(function (emoji, i) {
      var b = el('button', 'avatar-opt');
      b.type = 'button'; b.textContent = emoji; b.style.background = avatarStyle(emoji + i);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('selected'); });
        b.classList.add('selected'); me.avatar = emoji;
        try { localStorage.setItem('sala.avatar', emoji); } catch (e) {}
      });
      grid.appendChild(b);
    });

    var savedName = '', savedAvatar = '';
    try { savedName = localStorage.getItem('sala.name') || ''; savedAvatar = localStorage.getItem('sala.avatar') || ''; } catch (e) {}
    $('nameInput').value = savedName;
    var startIdx = AVATARS.indexOf(savedAvatar);
    if (startIdx < 0) startIdx = Math.floor(Math.random() * AVATARS.length);
    grid.children[startIdx].classList.add('selected');
    me.avatar = AVATARS[startIdx];

    var params = new URLSearchParams(location.search);
    var urlRoom = (params.get('sala') || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (urlRoom) {
      pendingRoomId = urlRoom;
      $('roomCodeShown').textContent = urlRoom;
      $('roomCodeRow').classList.remove('hidden');
      $('createBtn').textContent = 'Criar outra sala';
    }

    $('enterBtn').addEventListener('click', function () { startEnter(pendingRoomId || genCode()); });
    $('createBtn').addEventListener('click', function () { startEnter(genCode()); });
    $('nameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('enterBtn').click(); });
  }

  function startEnter(rid) {
    var name = $('nameInput').value.trim();
    if (!name) { toast('Escolha um nome pra entrar 🙂'); $('nameInput').focus(); return; }
    if (!me.avatar) { toast('Escolha um avatar'); return; }
    me.name = name;
    try { localStorage.setItem('sala.name', name); localStorage.setItem('sala.avatar', me.avatar); } catch (e) {}
    enterRoom(rid);
  }

  // =====================================================================
  // ENTRAR NA SALA
  // =====================================================================
  function enterRoom(rid) {
    roomId = rid;
    try { history.replaceState(null, '', '?sala=' + roomId); } catch (e) {}
    $('lobby').classList.add('hidden');
    $('room').classList.remove('hidden');
    $('roomCodeTop').textContent = roomId;
    document.title = 'Sala ' + roomId;

    connState('', 'conectando…');
    bindRoomUI();
    setupPip();
    tryBecomeHost();
    initMic(); // pede o microfone e liga a voz
  }

  function HOST_ID() { return HOST_PREFIX + roomId; }

  function tryBecomeHost() {
    cleanupPeer();
    peer = new Peer(HOST_ID(), PEER_CONFIG);
    peer.on('open', function (id) {
      isHost = true; me.id = id; joined = true; failedHostAttempts = 0;
      roster[id] = { name: me.name, avatar: me.avatar, live: false, muted: !micEnabled };
      setupPeerCommon();
      peer.on('connection', handleMemberConnection);
      connState('ok', 'conectado');
      renderPeople();
      systemMessage(me.name + ' criou a sala', true);
      toast('Sala criada! Toque no código pra copiar o convite.', 3400);
      if (micStream) applyMicTrack(micTrack);
    });
    peer.on('error', onPeerError);
  }

  function becomeMember() {
    cleanupPeer();
    isHost = false;
    peer = new Peer(undefined, PEER_CONFIG);
    peer.on('open', function (id) { me.id = id; joined = true; setupPeerCommon(); connectToHost(); });
    peer.on('error', onPeerError);
  }

  function connectToHost() {
    if (!peer || peer.destroyed) return;
    connState('', 'conectando…');
    var conn = peer.connect(HOST_ID(), { reliable: true, metadata: { name: me.name, avatar: me.avatar } });
    if (!conn) return;
    hostConn = conn;
    conn.on('open', function () {
      failedHostAttempts = 0; connState('ok', 'conectado');
      conn.send({ t: 'hello', name: me.name, avatar: me.avatar, muted: !micEnabled });
      if (localStream) conn.send({ t: 'live', live: true });
    });
    conn.on('data', handleDataFromHost);
    conn.on('close', function () { if (hostConn === conn) hostConn = null; onHostLost(); });
    conn.on('error', function () {});
  }

  function setupPeerCommon() {
    peer.on('call', function (call) {
      var kind = call.metadata && call.metadata.kind;
      if (kind === 'voice') handleIncomingVoice(call);
      else handleIncomingScreen(call);
    });
    peer.on('disconnected', function () { if (peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} } });
  }

  function onPeerError(err) {
    var type = err && err.type;
    if (type === 'unavailable-id' && !isHost) { becomeMember(); return; }
    if (type === 'peer-unavailable') return;
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') { connState('warn', 'reconectando…'); return; }
    console.warn('[peer]', type, err);
    connState('warn', 'instável');
  }

  function cleanupPeer() {
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null; hostConn = null; memberConns = {};
  }

  function onHostLost() {
    if (isHost) return;
    connState('warn', 'reconectando…');
    if (reconnectTimer) return;
    failedHostAttempts = 0;
    reconnectTimer = setInterval(function () {
      if (!peer || peer.destroyed) { becomeMember(); return; }
      if (hostConn && hostConn.open) { clearInterval(reconnectTimer); reconnectTimer = null; return; }
      failedHostAttempts++;
      if (failedHostAttempts >= 3) {
        clearInterval(reconnectTimer); reconnectTimer = null;
        toast('Assumindo a sala…'); voiceSwept = false; tryBecomeHost();
      } else { connectToHost(); }
    }, 2500);
  }

  // =====================================================================
  // HOST: conexões de membros
  // =====================================================================
  function handleMemberConnection(conn) {
    conn.on('open', function () { memberConns[conn.peer] = conn; });
    conn.on('data', function (data) { handleDataFromMember(conn, data); });
    conn.on('close', function () {
      delete memberConns[conn.peer];
      var gone = roster[conn.peer];
      if (gone) { systemMessage(gone.name + ' saiu', true); delete roster[conn.peer]; broadcastRoster(); renderPeople(); }
      removeTile(conn.peer); removeVoice(conn.peer);
    });
    conn.on('error', function () {});
  }

  function handleDataFromMember(conn, data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case 'hello':
        roster[conn.peer] = { name: data.name || 'Anônimo', avatar: data.avatar || '❓', live: false, muted: !!data.muted };
        broadcastRoster(); renderPeople();
        systemMessage((data.name || 'Alguém') + ' entrou', true);
        break;
      case 'chat': relayChat(data); break;
      case 'live':
        if (roster[conn.peer]) { roster[conn.peer].live = !!data.live; broadcastRoster(); renderPeople(); }
        break;
      case 'micstate':
        if (roster[conn.peer]) { roster[conn.peer].muted = !!data.muted; broadcastRoster(); renderPeople(); }
        break;
    }
  }

  function broadcastRoster() {
    var payload = { t: 'roster', roster: roster };
    for (var pid in memberConns) if (memberConns[pid] && memberConns[pid].open) memberConns[pid].send(payload);
  }
  function broadcastToMembers(payload, exceptPeer) {
    for (var pid in memberConns) { if (pid === exceptPeer) continue; if (memberConns[pid] && memberConns[pid].open) memberConns[pid].send(payload); }
  }
  function relayChat(msg) { broadcastToMembers(msg); renderChat(msg); }

  // =====================================================================
  // MEMBRO: dados do host
  // =====================================================================
  function handleDataFromHost(data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case 'roster':
        roster = data.roster || {}; renderPeople(); refreshAllTileLabels();
        maybeCallNewScreenPeers(); sweepVoice();
        break;
      case 'chat': renderChat(data); break;
      case 'system': renderChat(data); break;
    }
  }

  // =====================================================================
  // UI da sala
  // =====================================================================
  function bindRoomUI() {
    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chatInput'); var text = input.value.trim();
      if (!text) return; input.value = ''; sendChat(text);
    });
    $('shareBtn').addEventListener('click', toggleShare);
    $('leaveBtn').addEventListener('click', leaveRoom);
    $('copyLinkBtn').addEventListener('click', copyInvite);
    $('sidebarToggle').addEventListener('click', function () { $('sidebar').classList.toggle('collapsed'); });
    $('micBtn').addEventListener('click', onMicBtn);
    $('pipBtn').addEventListener('click', togglePip);
    $('themeBtn').addEventListener('click', toggleTheme);

    // Settings
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', closeSettings);
    $('settingsOverlay').addEventListener('click', function (e) { if (e.target === $('settingsOverlay')) closeSettings(); });
    $('micSelect').addEventListener('change', function () {
      selectedMicId = this.value; try { localStorage.setItem('sala.micId', selectedMicId); } catch (e) {}
      initMic();
    });
    $('outputSelect').addEventListener('change', function () {
      selectedOutputId = this.value; try { localStorage.setItem('sala.outId', selectedOutputId); } catch (e) {}
      applyOutputToAll(); toast('Saída de áudio atualizada');
    });
    $('testSoundBtn').addEventListener('click', function () { playTestTone(selectedOutputId); });
    $('themeDark').addEventListener('click', function () { setTheme('dark'); });
    $('themeLight').addEventListener('click', function () { setTheme('light'); });

    updateMicBtn();
  }

  // =====================================================================
  // CHAT
  // =====================================================================
  function sendChat(text) {
    var msg = { t: 'chat', id: uid(), peerId: me.id, name: me.name, avatar: me.avatar, text: text, ts: Date.now() };
    renderChat(msg);
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
    if (!msg || !msg.id) msg.id = uid();
    if (seenMsgIds[msg.id]) return;
    seenMsgIds[msg.id] = 1;
    var log = $('chatLog');
    var row = el('div', 'chat-msg' + (msg.t === 'system' ? ' system' : ''));
    if (msg.t === 'system') {
      var st = el('div', 'chat-text'); st.textContent = msg.text; row.appendChild(st);
    } else {
      var ava = el('div', 'ava'); ava.textContent = msg.avatar || '❓'; ava.style.background = avatarStyle(msg.name || msg.peerId || 'x');
      var body = el('div', 'chat-body');
      var meta = el('div', 'chat-meta');
      var author = el('span', 'chat-author'); author.textContent = msg.name || 'Anônimo';
      var time = el('span', 'chat-time'); time.textContent = formatTime(msg.ts);
      meta.appendChild(author); meta.appendChild(time);
      var txt = el('div', 'chat-text'); txt.textContent = msg.text;
      body.appendChild(meta); body.appendChild(txt);
      row.appendChild(ava); row.appendChild(body);
    }
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.appendChild(row);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function formatTime(ts) {
    try { var d = new Date(ts || Date.now()); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    catch (e) { return ''; }
  }

  // =====================================================================
  // LISTA DE PESSOAS
  // =====================================================================
  function renderPeople() {
    var list = $('peopleList'); list.innerHTML = ''; peopleAvatarEls = {};
    var ids = Object.keys(roster);
    $('peopleCount').textContent = ids.length;
    ids.forEach(function (pid) {
      var p = roster[pid];
      var li = el('li', 'person');
      var ava = el('div', 'ava'); ava.textContent = p.avatar || '❓'; ava.style.background = avatarStyle(p.name || pid);
      if (speakingState[pid]) ava.classList.add('speaking');
      peopleAvatarEls[pid] = ava;
      var name = el('span', 'p-name'); name.textContent = p.name || 'Anônimo';
      li.appendChild(ava); li.appendChild(name);
      if (pid === me.id) { var you = el('span', 'you-tag'); you.textContent = 'você'; li.appendChild(you); }
      if (p.muted) { var m = el('span', 'p-muted'); m.title = 'Microfone desligado'; m.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>'; li.appendChild(m); }
      if (p.live) { var live = el('span', 'p-live'); var dot = el('span', 'live-dot'); live.appendChild(dot); live.appendChild(document.createTextNode('ao vivo')); li.appendChild(live); }
      list.appendChild(li);
    });
  }

  // =====================================================================
  // VOZ (mic mesh P2P)
  // =====================================================================
  function initMic() {
    var base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    var audio = selectedMicId ? Object.assign({ deviceId: { exact: selectedMicId } }, base) : base;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { updateMicBtn(); return Promise.resolve(false); }
    return navigator.mediaDevices.getUserMedia({ audio: audio, video: false }).then(function (stream) {
      setMicStream(stream); micEnabled = true; applyMicEnabled(); return true;
    }).catch(function (err) {
      console.warn('mic', err && err.name);
      if (err && err.name === 'NotAllowedError') toast('Microfone bloqueado — libere no navegador pra falar.', 3600);
      updateMicBtn(); return false;
    });
  }

  function setMicStream(stream) {
    if (micStream && micStream !== stream) micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    micStream = stream; micTrack = stream.getAudioTracks()[0];
    if (micTrack) micTrack.enabled = micEnabled;
    addAnalyser(me.id, stream);
    applyMicTrack(micTrack);
    broadcastMicState();
    if (!isHost) sweepVoice();
  }

  function applyMicTrack(track) {
    if (!track) return;
    Object.keys(voiceCalls).forEach(function (pid) {
      var pc = voiceCalls[pid] && voiceCalls[pid].peerConnection; if (!pc) return;
      var sender = pc.getSenders().filter(function (s) { return s.track && s.track.kind === 'audio'; })[0];
      if (sender) { try { sender.replaceTrack(track); } catch (e) {} }
    });
  }

  // Recém-chegado liga pra todos que já estão na sala (evita conexão dupla)
  function sweepVoice() {
    if (isHost || voiceSwept || !micStream) return;
    var others = Object.keys(roster).filter(function (p) { return p !== me.id; });
    if (others.length === 0) return;
    voiceSwept = true;
    others.forEach(function (pid) { if (!voiceCalls[pid]) startVoiceCall(pid); });
  }

  function startVoiceCall(pid) {
    if (!peer || !micStream || pid === me.id || voiceCalls[pid]) return;
    var call = peer.call(pid, micStream, { metadata: { kind: 'voice' } });
    if (!call) return;
    voiceCalls[pid] = call;
    call.on('stream', function (s) { setRemoteVoice(pid, s); });
    call.on('close', function () { delete voiceCalls[pid]; removeVoice(pid); });
    call.on('error', function () { delete voiceCalls[pid]; });
  }

  function handleIncomingVoice(call) {
    var pid = call.peer;
    if (voiceCalls[pid] && voiceCalls[pid].open) {
      if (pid > me.id) { try { voiceCalls[pid].close(); } catch (e) {} }
      else { try { call.close(); } catch (e) {} return; }
    }
    call.answer(micStream || undefined);
    voiceCalls[pid] = call;
    call.on('stream', function (s) { setRemoteVoice(pid, s); });
    call.on('close', function () { delete voiceCalls[pid]; removeVoice(pid); });
    call.on('error', function () { delete voiceCalls[pid]; });
  }

  function setRemoteVoice(pid, stream) {
    var a = voiceAudios[pid];
    if (!a) { a = new Audio(); a.autoplay = true; a.dataset.pid = pid; $('audioSink').appendChild(a); voiceAudios[pid] = a; }
    a.srcObject = stream;
    if (selectedOutputId && a.setSinkId) a.setSinkId(selectedOutputId).catch(function () {});
    if (a.play) a.play().catch(function () {});
    addAnalyser(pid, stream);
  }
  function removeVoice(pid) {
    var a = voiceAudios[pid];
    if (a) { try { a.srcObject = null; } catch (e) {} if (a.parentNode) a.parentNode.removeChild(a); delete voiceAudios[pid]; }
    removeAnalyser(pid); setSpeaking(pid, false);
  }

  function onMicBtn() { if (!micStream) { initMic(); return; } micEnabled = !micEnabled; applyMicEnabled(); }
  function applyMicEnabled() { if (micTrack) micTrack.enabled = micEnabled; updateMicBtn(); broadcastMicState(); }

  function broadcastMicState() {
    var muted = !micEnabled || !micStream;
    if (isHost) { if (roster[me.id]) roster[me.id].muted = muted; broadcastRoster(); renderPeople(); }
    else if (hostConn && hostConn.open) hostConn.send({ t: 'micstate', muted: muted });
  }

  function updateMicBtn() {
    var on = micEnabled && !!micStream;
    $('iconMicOn').classList.toggle('hidden', !on);
    $('iconMicOff').classList.toggle('hidden', on);
    $('micBtn').classList.toggle('muted', !on);
    $('micBtnLabel').textContent = on ? 'Microfone' : (micStream ? 'Mudo' : 'Ativar mic');
  }

  // =====================================================================
  // VAD (detecção de fala) — um único loop pra todos
  // =====================================================================
  function ensureAudioCtx() {
    if (!audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; audioCtx = new AC(); }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function addAnalyser(pid, stream) {
    try {
      var ctx = ensureAudioCtx();
      if (analysers[pid]) { try { analysers[pid].src.disconnect(); } catch (e) {} }
      var src = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.4;
      src.connect(analyser);
      analysers[pid] = { src: src, analyser: analyser, data: new Uint8Array(analyser.fftSize), last: 0 };
      if (!vadRunning) { vadRunning = true; requestAnimationFrame(vadLoop); }
    } catch (e) {}
  }
  function removeAnalyser(pid) {
    if (analysers[pid]) { try { analysers[pid].src.disconnect(); } catch (e) {} delete analysers[pid]; }
  }
  function vadLoop() {
    var now = performance.now();
    for (var pid in analysers) {
      var a = analysers[pid];
      a.analyser.getByteTimeDomainData(a.data);
      var sum = 0; for (var i = 0; i < a.data.length; i++) { var x = (a.data[i] - 128) / 128; sum += x * x; }
      var rms = Math.sqrt(sum / a.data.length);
      var isMe = pid === me.id;
      if (isMe) localMicLevel = (micEnabled ? Math.min(1, rms / 0.25) : 0);
      var speakingNow = rms > SPEAK_THRESHOLD && (!isMe || micEnabled);
      if (speakingNow) a.last = now;
      var eff = (now - a.last) < SPEAK_HANGOVER;
      if (eff !== !!speakingState[pid]) setSpeaking(pid, eff);
    }
    if (settingsOpen) { var f = $('micMeterFill'); if (f) f.style.width = Math.round(localMicLevel * 100) + '%'; }
    if (pipActive) drawPip();
    requestAnimationFrame(vadLoop);
  }
  function setSpeaking(pid, on) {
    speakingState[pid] = on;
    var av = peopleAvatarEls[pid]; if (av) av.classList.toggle('speaking', on);
    var t = incomingTiles[pid]; if (t && t.tile) t.tile.classList.toggle('speaking', on);
  }

  // =====================================================================
  // TRANSMISSÃO DE TELA (mesh P2P)
  // =====================================================================
  function toggleShare() { if (localStream) stopSharing(); else startSharing(); }
  function startSharing() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast('Seu navegador não suporta compartilhar tela.'); return; }
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: true }).then(function (stream) {
      localStream = stream; setShareButton(true); setLive(true); addSelfTile(stream);
      Object.keys(roster).forEach(function (pid) { if (pid !== me.id) callScreen(pid); });
      stream.getVideoTracks()[0].addEventListener('ended', function () { stopSharing(); });
    }).catch(function (err) { if (err && err.name !== 'NotAllowedError') toast('Não foi possível compartilhar: ' + (err.name || err)); });
  }
  function callScreen(pid) {
    if (!peer || !localStream || pid === me.id) return;
    if (outgoingCalls[pid]) { try { outgoingCalls[pid].close(); } catch (e) {} }
    var call = peer.call(pid, localStream, { metadata: { kind: 'screen' } });
    if (!call) return;
    outgoingCalls[pid] = call;
    call.on('close', function () { delete outgoingCalls[pid]; });
    call.on('error', function () { delete outgoingCalls[pid]; });
  }
  function maybeCallNewScreenPeers() {
    if (!localStream) return;
    Object.keys(roster).forEach(function (pid) { if (pid !== me.id && !outgoingCalls[pid]) callScreen(pid); });
  }
  function handleIncomingScreen(call) {
    call.answer();
    call.on('stream', function (s) { addRemoteTile(call.peer, s); });
    call.on('close', function () { removeTile(call.peer); });
    call.on('error', function () { removeTile(call.peer); });
  }
  function stopSharing() {
    if (localStream) localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    localStream = null;
    Object.keys(outgoingCalls).forEach(function (pid) { try { outgoingCalls[pid].close(); } catch (e) {} });
    outgoingCalls = {};
    removeTile(me.id); setShareButton(false); setLive(false);
  }
  function setLive(live) {
    if (isHost) { if (roster[me.id]) roster[me.id].live = live; broadcastRoster(); renderPeople(); }
    else if (hostConn && hostConn.open) hostConn.send({ t: 'live', live: live });
  }
  function setShareButton(on) {
    var btn = $('shareBtn'), label = $('shareBtnLabel');
    if (on) { btn.classList.add('is-live'); label.textContent = 'Parar transmissão'; }
    else { btn.classList.remove('is-live'); label.textContent = 'Transmitir tela'; }
  }

  // =====================================================================
  // TILES DE VÍDEO
  // =====================================================================
  function addSelfTile(stream) { addTile(me.id, stream, true); }
  function addRemoteTile(pid, stream) { addTile(pid, stream, false); }
  function addTile(pid, stream, isSelf) {
    var existing = incomingTiles[pid];
    if (existing) { existing.video.srcObject = stream; existing.stream = stream; return; }
    var grid = $('videoGrid');
    var tile = el('div', 'video-tile' + (isSelf ? ' self' : ''));
    if (speakingState[pid]) tile.classList.add('speaking');
    var video = el('video');
    video.autoplay = true; video.playsInline = true; video.muted = isSelf; video.srcObject = stream;
    if (video.play) video.play().catch(function () {});
    var label = el('div', 'tile-label');
    var mini = el('div', 'mini-ava');
    var info = roster[pid] || (isSelf ? { name: me.name, avatar: me.avatar } : { name: 'Alguém', avatar: '❓' });
    mini.textContent = info.avatar || '❓'; mini.style.background = avatarStyle(info.name || pid);
    var nameSpan = el('span'); nameSpan.textContent = (info.name || 'Alguém') + (isSelf ? ' (você)' : '');
    label.appendChild(mini); label.appendChild(nameSpan);
    tile.appendChild(video); tile.appendChild(label); grid.appendChild(tile);
    incomingTiles[pid] = { tile: tile, video: video, stream: stream, nameSpan: nameSpan, mini: mini };
    refreshStage();
  }
  function removeTile(pid) {
    var t = incomingTiles[pid]; if (!t) return;
    try { t.video.srcObject = null; } catch (e) {}
    if (t.tile && t.tile.parentNode) t.tile.parentNode.removeChild(t.tile);
    delete incomingTiles[pid]; refreshStage();
  }
  function refreshAllTileLabels() {
    Object.keys(incomingTiles).forEach(function (pid) {
      var info = roster[pid]; if (!info) return; var t = incomingTiles[pid];
      if (t.nameSpan) t.nameSpan.textContent = (info.name || 'Alguém') + (pid === me.id ? ' (você)' : '');
      if (t.mini) { t.mini.textContent = info.avatar || '❓'; t.mini.style.background = avatarStyle(info.name || pid); }
    });
  }
  function refreshStage() {
    var count = Object.keys(incomingTiles).length;
    var empty = $('emptyStage'), grid = $('videoGrid');
    if (count === 0) { if (empty) empty.style.display = ''; grid.classList.remove('multi', 'many'); }
    else { if (empty) empty.style.display = 'none'; grid.classList.toggle('multi', count > 1); grid.classList.toggle('many', count > 2); }
  }

  // =====================================================================
  // CONFIGURAÇÕES (áudio)
  // =====================================================================
  function openSettings() { settingsOpen = true; $('settingsOverlay').classList.remove('hidden'); updateThemeUI(currentTheme()); populateDevices(); }
  function closeSettings() { settingsOpen = false; $('settingsOverlay').classList.add('hidden'); }

  function populateDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var mics = devices.filter(function (d) { return d.kind === 'audioinput'; });
      var outs = devices.filter(function (d) { return d.kind === 'audiooutput'; });
      var micSel = $('micSelect'); micSel.innerHTML = '';
      if (mics.length === 0) { var o0 = document.createElement('option'); o0.textContent = 'Permita o microfone…'; micSel.appendChild(o0); micSel.disabled = true; }
      else {
        micSel.disabled = false;
        mics.forEach(function (d, i) { var o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || ('Microfone ' + (i + 1)); micSel.appendChild(o); });
        var cur = selectedMicId; if (!cur && micTrack && micTrack.getSettings) { var s = micTrack.getSettings(); if (s) cur = s.deviceId; }
        if (cur) micSel.value = cur;
      }
      var outSel = $('outputSelect'); var hint = $('outputHint');
      var supportsSink = 'setSinkId' in HTMLMediaElement.prototype;
      if (!supportsSink) { outSel.innerHTML = '<option>Padrão do sistema</option>'; outSel.disabled = true; hint.textContent = 'Seu navegador escolhe a saída (use Chrome/Edge pra trocar).'; }
      else if (outs.length === 0) { outSel.innerHTML = '<option>Padrão do sistema</option>'; outSel.disabled = true; hint.textContent = 'Nenhuma saída extra encontrada.'; }
      else {
        outSel.disabled = false; outSel.innerHTML = '';
        outs.forEach(function (d, i) { var o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || ('Saída ' + (i + 1)); outSel.appendChild(o); });
        if (selectedOutputId) outSel.value = selectedOutputId;
        hint.textContent = 'Toca um bip na saída escolhida.';
      }
    }).catch(function () {});
  }

  function applyOutputToAll() {
    if (!('setSinkId' in HTMLMediaElement.prototype) || !selectedOutputId) return;
    Object.keys(voiceAudios).forEach(function (pid) { var a = voiceAudios[pid]; if (a && a.setSinkId) a.setSinkId(selectedOutputId).catch(function () {}); });
  }

  function playTestTone(deviceId) {
    try {
      var ctx = ensureAudioCtx();
      var dest = ctx.createMediaStreamDestination();
      var osc = ctx.createOscillator(); var gain = ctx.createGain();
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
  // PICTURE-IN-PICTURE (canvas com avatares + fala)
  // =====================================================================
  function setupPip() {
    pipCanvas = $('pipCanvas'); pipVideo = $('pipVideo');
    if (!pipCanvas) return;
    pipCtx = pipCanvas.getContext('2d');
    drawPip();
    try { pipStream = pipCanvas.captureStream(15); pipVideo.srcObject = pipStream; pipVideo.play().catch(function () {}); } catch (e) {}
    pipVideo.addEventListener('leavepictureinpicture', function () { pipActive = false; $('pipBtn').classList.remove('active'); });
    pipVideo.addEventListener('enterpictureinpicture', function () { pipActive = true; $('pipBtn').classList.add('active'); });
  }

  function togglePip() {
    if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(function () {}); return; }
    if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) { toast('Seu navegador não suporta janela flutuante (PiP).'); return; }
    pipActive = true; drawPip();
    var go = function () { pipVideo.requestPictureInPicture().then(function () { $('pipBtn').classList.add('active'); toast('Janela flutuante ligada — mostra quem está falando fora da aba 👀', 3200); }).catch(function () { pipActive = false; toast('Não consegui abrir a janela flutuante.'); }); };
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
    var cv = pipCanvas, ctx = pipCtx, W = cv.width, H = cv.height;
    ctx.fillStyle = '#14161d'; ctx.fillRect(0, 0, W, H);
    var ids = Object.keys(roster);
    if (ids.length === 0 && me.id) ids = [me.id];
    var n = ids.length || 1;
    var cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    var rows = Math.ceil(n / cols);
    var cw = W / cols, ch = H / rows;
    ids.forEach(function (pid, idx) {
      var cx = (idx % cols) * cw + cw / 2;
      var cy = Math.floor(idx / cols) * ch + ch / 2 - 6;
      var r = Math.min(cw, ch) * 0.24;
      var info = roster[pid] || (pid === me.id ? { name: me.name, avatar: me.avatar } : { name: '?', avatar: '❓' });
      if (speakingState[pid]) { ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.strokeStyle = '#3ddc84'; ctx.lineWidth = 4; ctx.stroke(); }
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = avatarColor(info.name || pid); ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = Math.round(r * 1.15) + 'px sans-serif';
      ctx.fillText(info.avatar || '❓', cx, cy + 2);
      if (info.muted) { ctx.font = Math.round(r * 0.55) + 'px sans-serif'; ctx.fillText('🔇', cx + r * 0.7, cy - r * 0.7); }
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
      ctx.font = '600 ' + Math.max(11, Math.round(r * 0.42)) + 'px Inter, sans-serif';
      var nm = (info.name || '') + (pid === me.id ? ' (você)' : '');
      ctx.fillText(pipTruncate(ctx, nm, cw - 8), cx, cy + r + 7);
    });
  }

  // =====================================================================
  // AÇÕES DA SALA
  // =====================================================================
  function copyInvite() {
    var url = inviteUrl();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast('Link copiado! Manda pros amigos 🎉'); }).catch(function () { promptCopy(url); });
    } else promptCopy(url);
  }
  function promptCopy(url) { window.prompt('Copie o link da sala:', url); }

  function leaveRoom() {
    if (!window.confirm('Sair da sala?')) return;
    stopSharing();
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
    Object.keys(voiceCalls).forEach(function (pid) { try { voiceCalls[pid].close(); } catch (e) {} });
    Object.keys(incomingTiles).forEach(removeTile);
    if (micStream) micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    cleanupPeer();
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    location.href = location.origin + location.pathname;
  }

  window.addEventListener('beforeunload', function () {
    try { if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
  });

  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof Peer === 'undefined') toast('Falha ao carregar o motor de conexão (PeerJS).', 6000);
    initLobby();
  });
})();
