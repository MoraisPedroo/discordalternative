/* =========================================================================
   Sala — transmissão de tela P2P + chat, 100% no navegador (sem backend).
   Sinalização e presença via PeerJS (broker gratuito). Vídeo vai P2P.
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

  var HOST_PREFIX = 'dalt-'; // prefixo do id determinístico do host

  // ---------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------
  var me = { name: '', avatar: '', id: null };
  var roomId = null;
  var isHost = false;

  var peer = null;
  var hostConn = null;          // (membro) conexão de dados com o host
  var memberConns = {};         // (host) peerId -> DataConnection
  var roster = {};              // peerId -> { name, avatar, live }
  var outgoingCalls = {};       // (quem transmite) peerId -> MediaConnection
  var incomingTiles = {};       // peerId -> { tile, video, stream }
  var localStream = null;
  var seenMsgIds = {};
  var reconnectTimer = null;
  var failedHostAttempts = 0;
  var joined = false;

  // ---------------------------------------------------------------------
  // Helpers de DOM
  // ---------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  }

  function connState(kind, text) {
    var c = $('connState');
    c.textContent = text;
    c.className = 'conn-state' + (kind ? ' ' + kind : '');
  }

  // Cor consistente por pessoa (gradiente derivado do nome)
  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
    return Math.abs(h);
  }
  function avatarStyle(seed) {
    var h = hashStr(seed || 'x');
    var hue = h % 360;
    return 'linear-gradient(135deg, hsl(' + hue + ',70%,55%), hsl(' + ((hue + 40) % 360) + ',70%,45%))';
  }

  function genCode() {
    var s = Math.random().toString(36).replace(/[^a-z0-9]/g, '');
    while (s.length < 6) s += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
    return s.slice(0, 6);
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function inviteUrl() {
    return location.origin + location.pathname + '?sala=' + roomId;
  }

  // =====================================================================
  // LOBBY
  // =====================================================================
  var pendingRoomId = null;

  function initLobby() {
    // Avatares
    var grid = $('avatarGrid');
    AVATARS.forEach(function (emoji, i) {
      var b = el('button', 'avatar-opt');
      b.type = 'button';
      b.textContent = emoji;
      b.style.background = avatarStyle(emoji + i);
      b.setAttribute('role', 'option');
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('selected'); });
        b.classList.add('selected');
        me.avatar = emoji;
        try { localStorage.setItem('sala.avatar', emoji); } catch (e) {}
      });
      grid.appendChild(b);
    });

    // Restaurar preferências
    var savedName = '', savedAvatar = '';
    try { savedName = localStorage.getItem('sala.name') || ''; savedAvatar = localStorage.getItem('sala.avatar') || ''; } catch (e) {}
    $('nameInput').value = savedName;

    // Selecionar avatar salvo, ou um aleatório
    var startIdx = AVATARS.indexOf(savedAvatar);
    if (startIdx < 0) startIdx = Math.floor(Math.random() * AVATARS.length);
    grid.children[startIdx].classList.add('selected');
    me.avatar = AVATARS[startIdx];

    // Sala vinda da URL?
    var params = new URLSearchParams(location.search);
    var urlRoom = (params.get('sala') || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (urlRoom) {
      pendingRoomId = urlRoom;
      $('roomCodeShown').textContent = urlRoom;
      $('roomCodeRow').classList.remove('hidden');
      $('createBtn').textContent = 'Criar outra sala';
    }

    $('enterBtn').addEventListener('click', function () {
      var rid = pendingRoomId || genCode();
      startEnter(rid);
    });
    $('createBtn').addEventListener('click', function () {
      startEnter(genCode());
    });
    $('nameInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('enterBtn').click();
    });
  }

  function startEnter(rid) {
    var name = $('nameInput').value.trim();
    if (!name) { toast('Escolha um nome pra entrar 🙂'); $('nameInput').focus(); return; }
    if (!me.avatar) { toast('Escolha um avatar'); return; }
    me.name = name;
    try {
      localStorage.setItem('sala.name', name);
      localStorage.setItem('sala.avatar', me.avatar);
    } catch (e) {}
    enterRoom(rid);
  }

  // =====================================================================
  // ENTRAR NA SALA
  // =====================================================================
  function enterRoom(rid) {
    roomId = rid;
    // Atualiza URL sem recarregar
    try { history.replaceState(null, '', '?sala=' + roomId); } catch (e) {}

    $('lobby').classList.add('hidden');
    $('room').classList.remove('hidden');
    $('roomCodeTop').textContent = roomId;
    document.title = 'Sala ' + roomId;

    connState('', 'conectando…');
    bindRoomUI();
    tryBecomeHost();
  }

  var HOST_ID = function () { return HOST_PREFIX + roomId; };

  function tryBecomeHost() {
    cleanupPeer();
    peer = new Peer(HOST_ID(), PEER_CONFIG);
    peer.on('open', function (id) {
      isHost = true;
      me.id = id;
      joined = true;
      failedHostAttempts = 0;
      roster[id] = { name: me.name, avatar: me.avatar, live: false };
      setupPeerCommon();
      peer.on('connection', handleMemberConnection);
      connState('ok', 'conectado');
      renderPeople();
      systemMessage(me.name + ' criou a sala', true);
      toast('Sala criada! Toque no código pra copiar o convite.', 3400);
    });
    peer.on('error', onPeerError);
  }

  function becomeMember() {
    cleanupPeer();
    isHost = false;
    peer = new Peer(undefined, PEER_CONFIG);
    peer.on('open', function (id) {
      me.id = id;
      joined = true;
      setupPeerCommon();
      connectToHost();
    });
    peer.on('error', onPeerError);
  }

  function connectToHost() {
    if (!peer || peer.destroyed) return;
    connState('', 'conectando…');
    var conn = peer.connect(HOST_ID(), { reliable: true, metadata: { name: me.name, avatar: me.avatar } });
    if (!conn) return;
    hostConn = conn;

    conn.on('open', function () {
      failedHostAttempts = 0;
      connState('ok', 'conectado');
      conn.send({ t: 'hello', name: me.name, avatar: me.avatar });
      // Se eu já estava transmitindo (reconexão), avisa
      if (localStream) conn.send({ t: 'live', live: true });
    });
    conn.on('data', handleDataFromHost);
    conn.on('close', function () {
      if (hostConn === conn) hostConn = null;
      onHostLost();
    });
    conn.on('error', function () { /* tratado no peer error */ });
  }

  function setupPeerCommon() {
    // Recebe chamadas de vídeo de quem transmite (tanto host quanto membro)
    peer.on('call', function (call) {
      call.answer(); // respondemos sem enviar mídia (só recebemos)
      call.on('stream', function (stream) { addRemoteTile(call.peer, stream); });
      call.on('close', function () { removeTile(call.peer); });
      call.on('error', function () { removeTile(call.peer); });
    });
    peer.on('disconnected', function () {
      // Conexão com o broker caiu — tenta reabrir
      if (peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} }
    });
  }

  function onPeerError(err) {
    var type = err && err.type;
    if (type === 'unavailable-id' && !isHost) {
      // Já existe um host nessa sala → entro como membro
      becomeMember();
      return;
    }
    if (type === 'peer-unavailable') {
      // Host alvo indisponível (provavelmente saiu/recarregando)
      return; // o loop de reconexão cuida disso
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      connState('warn', 'reconectando…');
      return;
    }
    console.warn('[peer]', type, err);
    connState('warn', 'instável');
  }

  function cleanupPeer() {
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null;
    hostConn = null;
    memberConns = {};
  }

  // ---------------------------------------------------------------------
  // Reconexão / troca de host
  // ---------------------------------------------------------------------
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
        // Host provavelmente foi embora de vez → tento assumir a sala
        clearInterval(reconnectTimer); reconnectTimer = null;
        toast('Assumindo a sala…');
        tryBecomeHost();
      } else {
        connectToHost();
      }
    }, 2500);
  }

  // =====================================================================
  // HOST: conexões de membros
  // =====================================================================
  function handleMemberConnection(conn) {
    conn.on('open', function () {
      memberConns[conn.peer] = conn;
    });
    conn.on('data', function (data) { handleDataFromMember(conn, data); });
    conn.on('close', function () {
      delete memberConns[conn.peer];
      var gone = roster[conn.peer];
      if (gone) {
        systemMessage(gone.name + ' saiu', true);
        delete roster[conn.peer];
        broadcastRoster();
        renderPeople();
      }
      removeTile(conn.peer);
    });
    conn.on('error', function () {});
  }

  function handleDataFromMember(conn, data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case 'hello':
        roster[conn.peer] = { name: data.name || 'Anônimo', avatar: data.avatar || '❓', live: false };
        broadcastRoster();
        renderPeople();
        systemMessage((data.name || 'Alguém') + ' entrou', true);
        break;
      case 'chat':
        // repassa a todos (inclusive quem enviou) e mostra pra mim
        relayChat(data);
        break;
      case 'live':
        if (roster[conn.peer]) { roster[conn.peer].live = !!data.live; broadcastRoster(); renderPeople(); updateTileLive(conn.peer); }
        break;
    }
  }

  function broadcastRoster() {
    var payload = { t: 'roster', roster: roster };
    for (var pid in memberConns) {
      if (memberConns[pid] && memberConns[pid].open) memberConns[pid].send(payload);
    }
  }

  function broadcastToMembers(payload, exceptPeer) {
    for (var pid in memberConns) {
      if (pid === exceptPeer) continue;
      if (memberConns[pid] && memberConns[pid].open) memberConns[pid].send(payload);
    }
  }

  function relayChat(msg) {
    // host mostra localmente e reenvia a todos os membros
    broadcastToMembers(msg);
    renderChat(msg);
  }

  // =====================================================================
  // MEMBRO: dados vindos do host
  // =====================================================================
  function handleDataFromHost(data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case 'roster':
        roster = data.roster || {};
        renderPeople();
        maybeCallNewPeers();
        refreshAllTileLabels();
        break;
      case 'chat':
        renderChat(data);
        break;
      case 'system':
        renderChat(data);
        break;
    }
  }

  // =====================================================================
  // CHAT
  // =====================================================================
  function bindRoomUI() {
    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chatInput');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendChat(text);
    });

    $('shareBtn').addEventListener('click', toggleShare);
    $('leaveBtn').addEventListener('click', leaveRoom);
    $('copyLinkBtn').addEventListener('click', copyInvite);
    $('sidebarToggle').addEventListener('click', function () {
      $('sidebar').classList.toggle('collapsed');
    });
  }

  function sendChat(text) {
    var msg = { t: 'chat', id: uid(), peerId: me.id, name: me.name, avatar: me.avatar, text: text, ts: Date.now() };
    renderChat(msg); // otimista
    if (isHost) {
      broadcastToMembers(msg);
    } else if (hostConn && hostConn.open) {
      hostConn.send(msg);
    } else {
      toast('Sem conexão com a sala…');
    }
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
      var st = el('div', 'chat-text');
      st.textContent = msg.text;
      row.appendChild(st);
    } else {
      var ava = el('div', 'ava');
      ava.textContent = msg.avatar || '❓';
      ava.style.background = avatarStyle(msg.name || msg.peerId || 'x');

      var body = el('div', 'chat-body');
      var meta = el('div', 'chat-meta');
      var author = el('span', 'chat-author');
      author.textContent = msg.name || 'Anônimo';
      var time = el('span', 'chat-time');
      time.textContent = formatTime(msg.ts);
      meta.appendChild(author); meta.appendChild(time);

      var txt = el('div', 'chat-text');
      txt.textContent = msg.text;

      body.appendChild(meta); body.appendChild(txt);
      row.appendChild(ava); row.appendChild(body);
    }

    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.appendChild(row);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function formatTime(ts) {
    try {
      var d = new Date(ts || Date.now());
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    } catch (e) { return ''; }
  }

  // =====================================================================
  // LISTA DE PESSOAS
  // =====================================================================
  function renderPeople() {
    var list = $('peopleList');
    list.innerHTML = '';
    var ids = Object.keys(roster);
    $('peopleCount').textContent = ids.length;

    ids.forEach(function (pid) {
      var p = roster[pid];
      var li = el('li', 'person');
      var ava = el('div', 'ava');
      ava.textContent = p.avatar || '❓';
      ava.style.background = avatarStyle(p.name || pid);

      var name = el('span', 'p-name');
      name.textContent = p.name || 'Anônimo';

      li.appendChild(ava);
      li.appendChild(name);

      if (pid === me.id) {
        var you = el('span', 'you-tag');
        you.textContent = 'você';
        li.appendChild(you);
      }
      if (p.live) {
        var live = el('span', 'p-live');
        var dot = el('span', 'live-dot');
        live.appendChild(dot);
        live.appendChild(document.createTextNode('ao vivo'));
        li.appendChild(live);
      }
      list.appendChild(li);
    });
  }

  // =====================================================================
  // TRANSMISSÃO DE TELA (mesh P2P)
  // =====================================================================
  function toggleShare() {
    if (localStream) stopSharing();
    else startSharing();
  }

  function startSharing() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Seu navegador não suporta compartilhar tela.');
      return;
    }
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true
    }).then(function (stream) {
      localStream = stream;
      setShareButton(true);
      setLive(true);
      addSelfTile(stream);

      // Liga pra todo mundo que já está na sala
      Object.keys(roster).forEach(function (pid) {
        if (pid !== me.id) callPeer(pid);
      });

      // Se o usuário parar pela UI nativa do navegador
      stream.getVideoTracks()[0].addEventListener('ended', function () { stopSharing(); });
    }).catch(function (err) {
      if (err && err.name !== 'NotAllowedError') toast('Não foi possível compartilhar: ' + (err.name || err));
    });
  }

  function callPeer(pid) {
    if (!peer || !localStream || pid === me.id) return;
    if (outgoingCalls[pid]) { try { outgoingCalls[pid].close(); } catch (e) {} }
    var call = peer.call(pid, localStream);
    if (!call) return;
    outgoingCalls[pid] = call;
    call.on('close', function () { delete outgoingCalls[pid]; });
    call.on('error', function () { delete outgoingCalls[pid]; });
  }

  // Quando o roster muda e eu estou ao vivo, ligo pra quem entrou depois
  function maybeCallNewPeers() {
    if (!localStream) return;
    Object.keys(roster).forEach(function (pid) {
      if (pid !== me.id && !outgoingCalls[pid]) callPeer(pid);
    });
  }

  function stopSharing() {
    if (localStream) {
      localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    localStream = null;
    Object.keys(outgoingCalls).forEach(function (pid) {
      try { outgoingCalls[pid].close(); } catch (e) {}
    });
    outgoingCalls = {};
    removeTile(me.id);
    setShareButton(false);
    setLive(false);
  }

  function setLive(live) {
    if (isHost) {
      if (roster[me.id]) roster[me.id].live = live;
      broadcastRoster();
      renderPeople();
    } else if (hostConn && hostConn.open) {
      hostConn.send({ t: 'live', live: live });
    }
  }

  function setShareButton(on) {
    var btn = $('shareBtn');
    var label = $('shareBtnLabel');
    if (on) { btn.classList.add('is-live'); label.textContent = 'Parar transmissão'; }
    else { btn.classList.remove('is-live'); label.textContent = 'Transmitir tela'; }
  }

  // =====================================================================
  // TILES DE VÍDEO
  // =====================================================================
  function addSelfTile(stream) {
    addTile(me.id, stream, true);
  }
  function addRemoteTile(pid, stream) {
    addTile(pid, stream, false);
  }

  function addTile(pid, stream, isSelf) {
    var existing = incomingTiles[pid];
    if (existing) {
      existing.video.srcObject = stream;
      existing.stream = stream;
      return;
    }
    var grid = $('videoGrid');
    var tile = el('div', 'video-tile' + (isSelf ? ' self' : ''));

    var video = el('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isSelf; // não ouço a mim mesmo (evita eco)
    video.srcObject = stream;
    video.play && video.play().catch(function () {});

    var label = el('div', 'tile-label');
    var mini = el('div', 'mini-ava');
    var info = roster[pid] || (isSelf ? { name: me.name, avatar: me.avatar } : { name: 'Alguém', avatar: '❓' });
    mini.textContent = info.avatar || '❓';
    mini.style.background = avatarStyle(info.name || pid);
    var dot = el('span', 'live-dot');
    var nameSpan = el('span');
    nameSpan.textContent = (info.name || 'Alguém') + (isSelf ? ' (você)' : '');
    label.appendChild(mini);
    label.appendChild(dot);
    label.appendChild(nameSpan);

    tile.appendChild(video);
    tile.appendChild(label);
    grid.appendChild(tile);

    incomingTiles[pid] = { tile: tile, video: video, stream: stream, nameSpan: nameSpan, mini: mini };
    refreshStage();
  }

  function removeTile(pid) {
    var t = incomingTiles[pid];
    if (!t) return;
    try { t.video.srcObject = null; } catch (e) {}
    if (t.tile && t.tile.parentNode) t.tile.parentNode.removeChild(t.tile);
    delete incomingTiles[pid];
    refreshStage();
  }

  function updateTileLive(pid) { /* o próprio tile já indica; hook para futuro */ }

  function refreshAllTileLabels() {
    Object.keys(incomingTiles).forEach(function (pid) {
      var info = roster[pid]; if (!info) return;
      var t = incomingTiles[pid];
      if (t.nameSpan) t.nameSpan.textContent = (info.name || 'Alguém') + (pid === me.id ? ' (você)' : '');
      if (t.mini) { t.mini.textContent = info.avatar || '❓'; t.mini.style.background = avatarStyle(info.name || pid); }
    });
  }

  function refreshStage() {
    var count = Object.keys(incomingTiles).length;
    var empty = $('emptyStage');
    var grid = $('videoGrid');
    if (count === 0) {
      if (empty) empty.style.display = '';
      grid.classList.remove('multi', 'many');
    } else {
      if (empty) empty.style.display = 'none';
      grid.classList.toggle('multi', count > 1);
      grid.classList.toggle('many', count > 2);
    }
  }

  // =====================================================================
  // AÇÕES DA SALA
  // =====================================================================
  function copyInvite() {
    var url = inviteUrl();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        toast('Link copiado! Manda pros amigos 🎉');
      }).catch(function () { promptCopy(url); });
    } else { promptCopy(url); }
  }
  function promptCopy(url) {
    window.prompt('Copie o link da sala:', url);
  }

  function leaveRoom() {
    if (!window.confirm('Sair da sala?')) return;
    stopSharing();
    Object.keys(incomingTiles).forEach(removeTile);
    cleanupPeer();
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    location.href = location.origin + location.pathname;
  }

  window.addEventListener('beforeunload', function () {
    try { if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
  });

  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof Peer === 'undefined') {
      toast('Falha ao carregar o motor de conexão (PeerJS).', 6000);
    }
    initLobby();
  });
})();
