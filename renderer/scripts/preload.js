const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close:    () => ipcRenderer.send('window:close')
  },
  navigate: (page) => ipcRenderer.send('navigate', page),
  // Lobi'den çıkıp navigate et — tek atomic IPC çağrısıyla, async güvenli
  lobbyLeaveAndNavigate: (lobbyName, summonerName, page) =>
    ipcRenderer.invoke('lobby:leaveAndNavigate', { lobbyName, summonerName, page }),
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (data) => ipcRenderer.invoke('config:set', data)
  },
  // DÜZELTME: Login sadece 2 parametre almalı
  login: (username, password) => ipcRenderer.invoke('login:check', { username, password }),
  register: (username, password, summonerName) => ipcRenderer.invoke('register:send', { username, password, summonerName }),
  
  lobby: {
    create: (data)             => ipcRenderer.invoke('lobby:create', data),
    getAll: ()                 => ipcRenderer.invoke('lobby:getAll'),
    getOne: (lobbyName)        => ipcRenderer.invoke('lobby:getOne', { lobbyName }),
    join:   (lobbyName, summonerName)=> ipcRenderer.invoke('lobby:join', { lobbyName, summonerName }),
    leave:  (lobbyName, summonerName)=> ipcRenderer.invoke('lobby:leave', { lobbyName, summonerName }),
    switchTeam: (lobbyName, summonerName) => ipcRenderer.invoke('lobby:switchTeam', { lobbyName, summonerName }),
startGame: (lobbyName, summonerName) => ipcRenderer.invoke('lobby:startGame', { lobbyName, summonerName }),
    cancelChampSelect: (lobbyName) => ipcRenderer.invoke('lobby:cancelChampSelect', { lobbyName }),
    // Aktif lobiyi main process'e bildir: pencere beklenmedik kapanırsa
    // (X, Alt+F4, crash) main process bu bilgiyle DB temizliği yapar.
    setActive:   (lobbyName, summonerName) => ipcRenderer.send('lobby:activeSet', { lobbyName, summonerName }),
    clearActive: ()                  => ipcRenderer.send('lobby:activeClear'),
  },
  game: {
    selectPath: () => ipcRenderer.invoke('game:selectPath'),
    selectServerPath: () => ipcRenderer.invoke('game:selectServerPath'),
launch: (lobbyName, summonerName, picks) => ipcRenderer.invoke('game:launch', { lobbyName, summonerName, picks }),
  },
champselect: {
    lockChampion: (lobbyName, summonerName, champion) =>
      ipcRenderer.invoke('champselect:lockChampion', { lobbyName, summonerName, champion }),
  },
friend: {
      add: (currentUsername, friendSummonerName) => ipcRenderer.invoke('friend:add', { currentUsername, friendSummonerName }),
    getList: (username) => ipcRenderer.invoke('friend:getList', { username }), // Bunu ekle
    getRequests: (username) => ipcRenderer.invoke('friend:getRequests', { username }), // Bunu ekle
        accept: (currentUsername, requesterName) => 
             ipcRenderer.invoke('friend:accept', { currentUsername, requesterName }),
        reject: (currentUsername, requesterName) => 
             ipcRenderer.invoke('friend:reject', { currentUsername, requesterName })
    },
  
  socket: {
    connect: (host, port) => ipcRenderer.invoke('socket:connect', { host, port }),
    send: (eventName, data) => ipcRenderer.invoke('socket:send', { eventName, data }),
    onEvent: (callback) => {
      const handler = (event, payload) => callback(payload.event, payload.data);
      ipcRenderer.on('socket:event', handler);
      return () => ipcRenderer.removeListener('socket:event', handler);
    }
  }
});