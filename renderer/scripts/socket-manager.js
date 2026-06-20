/**
 * LoL PvP.net Client - Socket Manager
 * BrokenWings / v1.0.0.26 Game Server Protocol
 *
 * ÖNEMLİ: Gerçek socket.io bağlantısı artık ELECTRON MAIN PROCESS'te yaşıyor
 * (main.js). Bu dosya sadece IPC üzerinden o bağlantıya emir gönderiyor ve
 * ondan gelen olayları dinliyor. Bu sayede index.html -> home.html ->
 * lobby.html -> champselect.html gibi sayfa geçişlerinde bağlantı KOPMUYOR.
 *
 * Sunucu event adlarını ayarlamak için bu dosyayı düzenleyin.
 * Edit SERVER_EVENTS / CLIENT_EVENTS to match your actual BrokenWings server.
 */

// ─── Event Name Maps ──────────────────────────────────────────────────────────
// Server'dan gelen eventler (BrokenWings kodunuzdaki gerçek isimlerle değiştirin)
const SERVER_EVENTS = {
  // Auth
  AUTH_SUCCESS:      'auth:success',
  AUTH_ERROR:        'auth:error',
  REGISTER_SUCCESS:  'auth:registered',
  REGISTER_ERROR:    'auth:register:error',

  // Lobby / Game List
  GAME_LIST:         'lobby:list',
  GAME_CREATED:      'lobby:created',
  GAME_JOINED:       'lobby:joined',
  GAME_LEFT:         'lobby:left',
  GAME_UPDATED:      'lobby:updated',
  PLAYER_JOINED:     'lobby:player:join',
  PLAYER_LEFT:       'lobby:player:leave',
  PLAYER_LIST:       'lobby:players',
  HOST_CHANGED:      'lobby:host:changed',
  KICKED:            'lobby:kicked',

  // Lokal (main.js'ten gelen) lobi odası senkronizasyon eventleri.
  // BrokenWings server entegre olmadan önce DB-tabanlı realtime güncelleme.
  ROOM_UPDATE:       'lobby:room:update',
  ROOM_CLOSED:       'lobby:room:closed',
  LIST_CHANGED:      'lobby:list:changed',

  // Champion Select
  CS_START:          'champselect:start',
  CS_PICK:           'champselect:pick',
  CS_LOCK:           'champselect:lock',
  CS_SPELL:          'champselect:spell',
  CS_TIMER:          'champselect:timer',
  CS_END:            'champselect:end',
  CS_CANCEL:         'champselect:cancel',

  // Game Start
  GAME_START:        'game:start',
  GAME_RECONNECT:    'game:reconnect',

  // Chat
  CHAT_MSG:          'chat:message',
  CHAT_ROOM:         'chat:room',

  // Profile / Friend
  FRIEND_LIST:       'friend:list',
  FRIEND_STATUS:     'friend:status',
  FRIEND_REQUEST:    'friend:request',
  FRIEND_ACCEPTED:   'friend:accepted',
  FRIEND_REMOVED:    'friend:removed',
  FRIEND_INVITE:     'friend:invite',

  // System
  SERVER_MSG:        'server:message',
};

// Client'dan giden eventler
const CLIENT_EVENTS = {
  // Auth
  LOGIN:             'auth:login',
  REGISTER:          'auth:register',
  LOGOUT:            'auth:logout',

  // Lobby
  GET_GAMES:         'lobby:list',
  GET_GAME:          'lobby:get',
  CREATE_GAME:       'lobby:create',
  JOIN_GAME:         'lobby:join',
  LEAVE_GAME:        'lobby:leave',
  START_GAME:        'lobby:start',
  KICK_PLAYER:       'lobby:kick',
  CHANGE_TEAM:       'lobby:team',
  TOGGLE_READY:      'lobby:ready',
  INVITE_FRIEND:     'lobby:invite',

  // Champion Select
  PICK_CHAMP:        'champselect:pick',
  LOCK_CHAMP:        'champselect:lock',
  SELECT_SPELLS:     'champselect:spells',

  // Chat
  CHAT_SEND:         'chat:send',

  // Friend
  FRIEND_ADD:        'friend:add',
  FRIEND_REMOVE:     'friend:remove',
  FRIEND_ACCEPT:     'friend:accept',

  // System
  PING:              'ping',
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  connected: false,
  connecting: false,
  user: null,
  game: null,
  players: [],
  friends: [],
  listeners: {},
  _listenerAttached: false,
};

// ─── Internal Event Emitter (sayfa içi dinleyiciler için) ─────────────────────
function on(event, fn) {
  if (!state.listeners[event]) state.listeners[event] = [];
  state.listeners[event].push(fn);
  return () => off(event, fn);
}

function off(event, fn) {
  if (state.listeners[event]) {
    state.listeners[event] = state.listeners[event].filter(f => f !== fn);
  }
}

function emit(event, data) {
  if (state.listeners[event]) {
    state.listeners[event].forEach(fn => {
      try { fn(data); } catch (e) { console.error('[SocketManager] listener error:', e); }
    });
  }
}

// ─── Server Event Dispatch Table ───────────────────────────────────────────────
// IPC üzerinden main process'ten gelen her olay buradan geçer.
const serverEventHandlers = {
  [SERVER_EVENTS.AUTH_SUCCESS]: (data) => {
    state.user = data.user || data;
    emit('auth:success', state.user);
  },
  [SERVER_EVENTS.AUTH_ERROR]: (data) => emit('auth:error', data),
  [SERVER_EVENTS.REGISTER_SUCCESS]: (data) => emit('register:success', data),
  [SERVER_EVENTS.REGISTER_ERROR]: (data) => emit('register:error', data),

  [SERVER_EVENTS.GAME_LIST]: (data) => emit('lobby:list', Array.isArray(data) ? data : (data?.games || [])),
  [SERVER_EVENTS.GAME_CREATED]: (data) => { state.game = data; emit('lobby:created', data); },
  [SERVER_EVENTS.GAME_JOINED]: (data) => {
    state.game = data.game || data;
    state.players = data.players || [];
    emit('lobby:joined', data);
  },
  [SERVER_EVENTS.GAME_LEFT]: (data) => { state.game = null; state.players = []; emit('lobby:left', data); },
  [SERVER_EVENTS.GAME_UPDATED]: (data) => {
    if (state.game) state.game = { ...state.game, ...data };
    emit('lobby:updated', data);
  },
  [SERVER_EVENTS.PLAYER_JOINED]: (data) => {
    if (!state.players.find(p => p.id === data.id)) state.players.push(data);
    emit('lobby:player:join', data);
  },
  [SERVER_EVENTS.PLAYER_LEFT]: (data) => {
    state.players = state.players.filter(p => p.id !== (data.id || data));
    emit('lobby:player:leave', data);
  },
  [SERVER_EVENTS.PLAYER_LIST]: (data) => {
    state.players = Array.isArray(data) ? data : (data?.players || []);
    emit('lobby:players', state.players);
  },
  [SERVER_EVENTS.HOST_CHANGED]: (data) => emit('lobby:host:changed', data),
  [SERVER_EVENTS.KICKED]: (data) => emit('lobby:kicked', data),

  // Lokal DB senkronizasyon eventleri (main.js içindeki broadcastLobby* fonksiyonları)
  [SERVER_EVENTS.ROOM_UPDATE]: (data) => emit('lobby:room:update', data),
  [SERVER_EVENTS.ROOM_CLOSED]: (data) => emit('lobby:room:closed', data),
  [SERVER_EVENTS.LIST_CHANGED]: (data) => emit('lobby:list:changed', data),

  [SERVER_EVENTS.CS_START]:  (data) => emit('champselect:start', data),
  [SERVER_EVENTS.CS_PICK]:   (data) => emit('champselect:pick', data),
  [SERVER_EVENTS.CS_LOCK]:   (data) => emit('champselect:lock', data),
  [SERVER_EVENTS.CS_SPELL]:  (data) => emit('champselect:spell', data),
  [SERVER_EVENTS.CS_TIMER]:  (data) => emit('champselect:timer', data),
  [SERVER_EVENTS.CS_END]:    (data) => emit('champselect:end', data),
  [SERVER_EVENTS.CS_CANCEL]: (data) => emit('champselect:cancel', data),

  [SERVER_EVENTS.GAME_START]:     (data) => emit('game:start', data),
  [SERVER_EVENTS.GAME_RECONNECT]: (data) => emit('game:reconnect', data),

  [SERVER_EVENTS.CHAT_MSG]:  (data) => emit('chat:message', data),
  [SERVER_EVENTS.CHAT_ROOM]: (data) => emit('chat:room', data),

  [SERVER_EVENTS.FRIEND_LIST]: (data) => {
    state.friends = Array.isArray(data) ? data : (data?.friends || []);
    emit('friend:list', state.friends);
  },
  [SERVER_EVENTS.FRIEND_STATUS]:   (data) => emit('friend:status', data),
  [SERVER_EVENTS.FRIEND_REQUEST]:  (data) => emit('friend:request', data),
  [SERVER_EVENTS.FRIEND_ACCEPTED]: (data) => emit('friend:accepted', data),
  [SERVER_EVENTS.FRIEND_REMOVED]:  (data) => emit('friend:removed', data),

  [SERVER_EVENTS.SERVER_MSG]: (data) => emit('server:message', data),
};

function dispatchEvent(eventName, data) {
  // Bağlantı yaşam döngüsü olayları
  if (eventName === 'connect') {
    state.connected = true;
    state.connecting = false;
    emit('connection:connected', { resumed: false });
    return;
  }
  if (eventName === 'disconnect') {
    state.connected = false;
    emit('connection:disconnected', data || {});
    return;
  }
  if (eventName === 'connect_error') {
    state.connecting = false;
    emit('connection:error', data || {});
    return;
  }
  if (eventName === 'reconnect') {
    state.connected = true;
    emit('connection:reconnected', data || {});
    return;
  }
  if (eventName === 'reconnect_attempt') {
    emit('connection:reconnecting', data || {});
    return;
  }

  // Socket.io kendi içsel eventleri - yoksay
  if (eventName.startsWith('socket.io') || eventName === 'pong') return;

  const handler = serverEventHandlers[eventName];
  if (handler) {
    handler(data);
  } else {
    // Haritalanmamış bir event geldi - geliştirici görsün diye logla.
    // BrokenWings sunucunuzun gerçek event adı SERVER_EVENTS objesindekiyle
    // eşleşmiyorsa burada görünecektir.
    console.log('[SocketManager] Haritalanmamış event:', eventName, data);
    emit('raw:' + eventName, data);
  }
}

// ─── Connect ──────────────────────────────────────────────────────────────────
async function connect(host, port) {
  if (state.connecting) return;
  state.connecting = true;

  // Bu sayfanın IPC dinleyicisini kur (her sayfa yüklemesinde script
  // sıfırdan çalıştığı için yeniden kurulması gerekir)
  if (!state._listenerAttached) {
    window.electron.socket.onEvent(dispatchEvent);
    state._listenerAttached = true;
  }

  try {
    // Önce zaten bağlı mı diye sor (sayfa geçişinden geliyorsak EVET olacak)
    const alreadyConnected = await window.electron.socket.isConnected();
    if (alreadyConnected) {
      state.connected = true;
      state.connecting = false;
      emit('connection:connected', { resumed: true });
      return;
    }

    await window.electron.socket.connect(host, port);
    // 'connect' olayı IPC üzerinden gelince state.connected = true olacak.
    setTimeout(() => { state.connecting = false; }, 11000);
  } catch (e) {
    console.error('[SocketManager] connect() hatası:', e);
    state.connecting = false;
    emit('connection:error', { message: e.message });
  }
}

// ─── Send Helpers ─────────────────────────────────────────────────────────────
function send(eventName, data) {
  window.electron.socket.send(eventName, data).then(ok => {
    if (!ok) console.warn('[Socket] Gönderilemedi (bağlı değil):', eventName);
  });
  return true;
}

function sendLogin(credentials)   { return send(CLIENT_EVENTS.LOGIN, credentials); }
function sendRegister(data)       { return send(CLIENT_EVENTS.REGISTER, data); }
function sendLogout() { send(CLIENT_EVENTS.LOGOUT, {}); state.user = null; }

function getGameList()            { return send(CLIENT_EVENTS.GET_GAMES, {}); }
function getCurrentGame()         { return send(CLIENT_EVENTS.GET_GAME, {}); }
function createGame(gameData)     { return send(CLIENT_EVENTS.CREATE_GAME, gameData); }
function joinGame(gameId, password = '') { return send(CLIENT_EVENTS.JOIN_GAME, { id: gameId, password }); }
function leaveGame()                { return send(CLIENT_EVENTS.LEAVE_GAME, {}); }
function startGame()                { return send(CLIENT_EVENTS.START_GAME, {}); }
function kickPlayer(playerId)       { return send(CLIENT_EVENTS.KICK_PLAYER, { id: playerId }); }
function changeTeam(team)           { return send(CLIENT_EVENTS.CHANGE_TEAM, { team }); }
function toggleReady(ready)         { return send(CLIENT_EVENTS.TOGGLE_READY, { ready }); }
function invitePlayer(summonerName) { return send(CLIENT_EVENTS.INVITE_FRIEND, { name: summonerName }); }

function pickChampion(championId)     { return send(CLIENT_EVENTS.PICK_CHAMP, { championId }); }
function lockChampion()                { return send(CLIENT_EVENTS.LOCK_CHAMP, {}); }
function selectSpells(spell1, spell2)  { return send(CLIENT_EVENTS.SELECT_SPELLS, { spell1, spell2 }); }

function sendChat(message, room = 'lobby') { return send(CLIENT_EVENTS.CHAT_SEND, { message, room }); }

function addFriend(summonerName)   { return send(CLIENT_EVENTS.FRIEND_ADD, { name: summonerName }); }
function removeFriend(summonerId)  { return send(CLIENT_EVENTS.FRIEND_REMOVE, { id: summonerId }); }
function acceptFriend(summonerId)  { return send(CLIENT_EVENTS.FRIEND_ACCEPT, { id: summonerId }); }

// ─── Getters ──────────────────────────────────────────────────────────────────
function getState()      { return { ...state }; }
function isConnected()   { return state.connected; }
function getUser()       { return state.user; }
function getGame()       { return state.game; }
function getPlayers()    { return [...state.players]; }
function getFriends()    { return [...state.friends]; }

// ─── Disconnect ───────────────────────────────────────────────────────────────
function disconnect() {
  window.electron.socket.disconnect();
  state.connected = false;
  state.connecting = false;
}

// ─── Export ───────────────────────────────────────────────────────────────────
window.SocketManager = {
  connect,
  disconnect,
  send,
  on,
  off,

  sendLogin,
  sendRegister,
  sendLogout,

  getGameList,
  getCurrentGame,
  createGame,
  joinGame,
  leaveGame,
  startGame,
  kickPlayer,
  changeTeam,
  toggleReady,
  invitePlayer,

  pickChampion,
  lockChampion,
  selectSpells,

  sendChat,

  addFriend,
  removeFriend,
  acceptFriend,

  getState,
  isConnected,
  getUser,
  getGame,
  getPlayers,
  getFriends,

  SERVER_EVENTS,
  CLIENT_EVENTS,
};