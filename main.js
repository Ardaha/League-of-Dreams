const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');

// ─── CONFIG (mongoose bağlantısından ÖNCE yüklenmeli) ───
// Daha önce mongoose.connect dosyanın en tepesinde sabit 'localhost:27017'
// kullanıyordu; config (serverHost/serverPort) o satırdan SONRA tanımlandığı
// için Ayarlar ekranına ne yazılırsa yazılsın hiç etkisi olmuyordu. Artık
// config önce diskten okunuyor, mongoose bağlantısı ondan sonra kuruluyor.
let config = { serverHost: '127.0.0.1', serverPort: 27017, gamePath: '', serverPath: '' };
const configPath = path.join(app.getPath('userData'), 'config.json');

try {
  if (fs.existsSync(configPath)) config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
} catch (e) {}

function saveConfig() { try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch (e) {} }

// Config'teki serverHost/serverPort'tan MongoDB bağlantı string'i kurar ve bağlanır.
// Ayarlar ekranından host/port değiştirilip kaydedildiğinde de tekrar çağrılır.
function connectMongo() {
  const host = config.serverHost || '127.0.0.1';
  const port = config.serverPort || 27017;
  const uri = `mongodb://${host}:${port}/league_db`;
  console.log('[MongoDB] Bağlanılıyor ->', uri);
  mongoose.connect(uri)
    .then(() => console.log('MongoDB Bağlandı!'))
    .catch(err => console.error('MongoDB Hatası:', err.message));
}
connectMongo();

// ─── MONGOOSE MODELLERİ ───
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  summonerName: String,
  friends: { type: Array, default: [] },        // Arkadaş olanlar
  friendRequests: { type: Array, default: [] }, // Bekleyen istekler
  status: { type: String, enum: ['pending', 'accepted'], default: 'pending' }
}));

// YENİ: Lobi için Mongoose Şeması eklendi
// hostIp: oyun başladığında diğer oyuncuların bağlanacağı host'un gerçek LAN IP'si.
// players[].champion / players[].locked: champselect sırasında her oyuncunun seçimi ve kilit durumu.
// players[].blowfishKey: her oyuncuya özel, BrokenWings server'ının ürettiği/beklediği
// formatta (16 byte base64) anahtar. Sunucu (Program.cs->LaunchGameClient) her oyuncuyu
// KENDİ blowfishKey'iyle bağlatıyor; tüm oyunculara aynı sabit anahtarı vermek host
// dışındaki oyuncuların bağlantısının reddedilmesine/senkron olamamasına yol açıyordu.
const Lobby = mongoose.model('Lobby', new mongoose.Schema({
  name: { type: String, required: true },
  mapId: { type: Number, required: true },
  host: { type: String, required: true },
  hostIp: { type: String, default: '' },
  players: { type: Array, default: [] },
  status: { type: String, default: 'Waiting' },
  createdAt: { type: Date, default: Date.now }
}));
// ──────────────────────────

// Host makinesinin LAN üzerindeki gerçek IPv4 adresini bulur (sanal/iç adresleri eler).
// Birden fazla aktif arayüz varsa ilkini döner; bulunamazsa 127.0.0.1'e düşer.
function getLocalIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Her oyuncuya özel, BrokenWings'in beklediği formatta (16 byte, base64 ile
// kodlanmış) bir blowfish anahtarı üretir. Orijinal sabit anahtar
// "17BLOhi6KZsTtldTsizvHg==" de tam 16 byte'lık rastgele veriyi base64'e
// çevirmenin sonucu (decode edilince 16 byte çıkıyor) — aynı uzunlukta
// üretiyoruz ki server tarafı formatı reddetmesin.
function generateBlowfishKey() {
  return crypto.randomBytes(16).toString('base64');
}

let gameSocket = null;
let mainWindow = null;
let currentGameProcess = null;

// Lobi odasındaki istemcilere anlık güncelleme göndermek için kullanılır.
// (Tek pencereli Electron app olduğundan tüm event'ler aynı mainWindow'a gider;
// renderer tarafında "şu an o lobide miyim" kontrolü yapılır.)
function broadcastLobbyUpdate(lobby) {
  if (!mainWindow) return;
  mainWindow.webContents.send('socket:event', {
    event: 'lobby:room:update',
    data: lobby
  });
}

function broadcastLobbyClosed(lobbyId) {
  if (!mainWindow) return;
  mainWindow.webContents.send('socket:event', {
    event: 'lobby:room:closed',
    data: { lobbyId }
  });
}

function broadcastLobbyListChanged() {
  if (!mainWindow) return;
  mainWindow.webContents.send('socket:event', { event: 'lobby:list:changed', data: {} });
}

// Belirtilen kullanıcıyı lobiden çıkarır; 0 oyuncu kalırsa lobiyi siler,
// host ayrılırsa yeni host atar. Tüm lobby:leave* yollarının ortak çekirdeği.
// Referans olarak artık MongoDB _id yerine lobi ADI kullanılıyor (ID dönüşüm
// hatalarından kaçınmak için — bkz. eski $oid/buffer temizleme katmanları).
async function removePlayerFromLobby(lobbyName, summonerName) {
  console.log('[REMOVE PLAYER]', lobbyName, summonerName);

  const lobby = await Lobby.findOne({ name: lobbyName });

  if (!lobby) {
    console.log('[REMOVE PLAYER] lobby not found');
    return { found: false };
  }

  console.log('[REMOVE PLAYER] before:', lobby.players);

  lobby.players = lobby.players.filter(
    p => p.name !== summonerName
  );

  console.log('[REMOVE PLAYER] after:', lobby.players);

  lobby.markModified('players');

  if (lobby.players.length === 0) {
    await Lobby.deleteOne({ _id: lobby._id });
    broadcastLobbyClosed(lobby.name);
    broadcastLobbyListChanged();
    return { found: true, closed: true };
  }

  if (lobby.host === summonerName) {
    lobby.host = lobby.players[0].name;
    lobby.players[0].isHost = true;
    lobby.markModified('players');
  }

  await lobby.save();
  const plain = lobby.toObject();
  broadcastLobbyUpdate(plain);
  broadcastLobbyListChanged();
  return { found: true, closed: false, lobby: plain };
}

// Uygulama herhangi bir şekilde kapanırsa (X tuşu, Alt+F4, crash sonrası
// işletim sistemi kapatması, vs.) o anda aktif olan lobiden kullanıcıyı
// düşürmeye çalışır. Renderer'dan gelen normal "Quit" akışı zaten
// lobby:leave / lobby:leaveAndNavigate ile bunu yapıyor; bu sadece son çare.
let pendingExitCleanup = null;
function registerActiveLobbyForCleanup(lobbyName, summonerName) {
  pendingExitCleanup = { lobbyName, summonerName };
}
function clearActiveLobbyForCleanup() {
  pendingExitCleanup = null;
}

function createWindow(page) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 720, resizable: false, frame: false, backgroundColor: '#0a0e1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false
    }
  });

  const filePath = path.join(__dirname, 'renderer', page);
  mainWindow.loadFile(filePath);
  
  // Geliştirici konsolunu otomatik açmak istersen bu satırı aktif bırakabilirsin
  // mainWindow.webContents.openDevTools(); 
  
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
}

app.whenReady().then(() => createWindow('index.html'));

// Pencere/uygulama hangi yoldan kapanırsa kapansın (X, Alt+F4, görev çubuğu,
// crash sonrası OS kapatması) aktif lobiden son bir kez çıkmayı dener.
// Renderer normal "Quit" akışında zaten lobby:leave çağırıp
// clearActiveLobbyForCleanup() ile bunu boşaltıyor; bu yalnızca son çare.
app.on('before-quit', async (e) => {
  if (!pendingExitCleanup) return;
  const { lobbyName, summonerName } = pendingExitCleanup;
  pendingExitCleanup = null;
  try {
    await removePlayerFromLobby(lobbyName, summonerName);
    console.log('[before-quit] Aktif lobiden çıkış temizliği yapıldı:', lobbyName);
  } catch (err) {
    console.error('[before-quit] Temizlik hatası:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// TEK BİR YERDE TANIMLANMIŞ IPC HANDLER'LAR
// ─────────────────────────────────────────────────────────────

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('navigate', (e, page) => mainWindow?.loadFile(path.join(__dirname, 'renderer', page)));

// Lobi bırakıp navigate et — renderer'dan lobbyName ve summonerName gelir, main process halleder
ipcMain.handle('lobby:leaveAndNavigate', async (e, { lobbyName, summonerName, page }) => {
    try {
        clearActiveLobbyForCleanup();
        await removePlayerFromLobby(lobbyName, summonerName);
    } catch (err) {
        console.error('[leaveAndNavigate] Hata:', err.message);
    }

    mainWindow?.loadFile(path.join(__dirname, 'renderer', page));
    return { success: true };
});

// Renderer, bir lobiye girdiğinde / çıktığında bunu bildirir; bu sayede
// pencere beklenmedik şekilde kapanırsa (X, Alt+F4, crash) before-quit
// hangi lobiden kullanıcıyı düşüreceğini bilir.
ipcMain.on('lobby:activeSet', (e, { lobbyName, summonerName }) => {
    registerActiveLobbyForCleanup(lobbyName, summonerName);
});
ipcMain.on('lobby:activeClear', () => {
    clearActiveLobbyForCleanup();
});

ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (e, cfg) => {
    const hostOrPortChanged = (cfg.serverHost && cfg.serverHost !== config.serverHost) ||
                               (cfg.serverPort && cfg.serverPort !== config.serverPort);
    config = { ...config, ...cfg };
    saveConfig();
    // Kullanıcı Ayarlar ekranından MongoDB host/port'unu değiştirdiyse,
    // uygulamayı yeniden başlatmaya gerek kalmadan bağlantıyı yeniliyoruz.
    if (hostOrPortChanged) {
        mongoose.disconnect().catch(() => {}).finally(() => connectMongo());
    }
    return config;
});

ipcMain.handle('register:send', async (e, data) => {
    try {
        const { username, password, summonerName } = data;
        if (await User.findOne({ username })) return { success: false, message: 'Kullanıcı zaten var!' };
        const newUser = await new User({ username, password, summonerName }).save();
        return { success: true, message: 'Kayıt başarılı!', user: newUser.toObject() };
    } catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('login:check', async (e, { username, password }) => {
    try {
        const user = await User.findOne({ username, password });
        return user ? { success: true, user: user.toObject() } : { success: false, message: 'Hatalı giriş!' };
    } catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('game:selectPath', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (!res.canceled) { config.gamePath = res.filePaths[0]; saveConfig(); return config.gamePath; }
    return null;
});

// BrokenWings server'ının "net9.0" build klasörünü (ChildrenOfTheGraveServerConsole.exe'nin
// bulunduğu yer) kullanıcıya seçtiriyoruz; artık D: sürücüsünde sabit kodlu yol yok.
ipcMain.handle('game:selectServerPath', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (!res.canceled) { config.serverPath = res.filePaths[0]; saveConfig(); return config.serverPath; }
    return null;
});

// YENİ: Lobi Oluşturma Handler'ı
ipcMain.handle('lobby:create', async (e, data) => {
    try {
        const { name, mapId, host } = data;
        // Host'un gerçek LAN IP'sini otomatik tespit edip lobiye kaydediyoruz;
        // oyun başladığında diğer oyuncular bu adrese bağlanacak.
        const hostIp = getLocalIPv4();
        // Yeni lobi oluştur ve oluşturanı ilk oyuncu olarak ekle (varsayılan takım: BLUE)
        const newLobby = new Lobby({
            name, mapId, host, hostIp,
            players: [{ name: host, isHost: true, team: 'BLUE', champion: null, locked: false, blowfishKey: generateBlowfishKey() }]
        });
        await newLobby.save();
        const plain = newLobby.toObject();
        broadcastLobbyListChanged();
        return { success: true, lobby: plain };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// Tüm lobileri listele (oyun başlamış olanlar listede görünmesin diye sadece Waiting)
ipcMain.handle('lobby:getAll', async () => {
    try {
        const lobbies = await Lobby.find({ status: 'Waiting' }).lean();
        return { success: true, lobbies };
    } catch (err) {
        return { success: false, lobbies: [], message: err.message };
    }
});

// Lobiden ayrıl — 0 oyuncu kalırsa lobiyi sil. Referans: lobi ADI.
ipcMain.handle('lobby:leave', async (e, { lobbyName, summonerName }) => {
    try {
        const result = await removePlayerFromLobby(lobbyName, summonerName);
        if (!result.found) {
            console.log('[lobby:leave] Lobi bulunamadı, ad:', lobbyName);
            return { success: true, closed: true }; // Zaten yok, sorun değil
        }
        if (result.closed) {
            console.log('[lobby:leave] Lobi silindi (boş kaldı):', lobbyName);
            return { success: true, closed: true };
        }
        console.log('[lobby:leave] Oyuncu çıktı, lobi devam ediyor:', lobbyName);
        return { success: true, closed: false, lobby: result.lobby };
    } catch (err) {
        console.error('[lobby:leave] Hata:', err.message);
        return { success: false, message: err.message };
    }
});

// Lobiye katıl — Referans: lobi ADI (host ile birlikte UI tarafında lobi seçilir).
// Katılan oyuncu varsayılan olarak BLUE takımına eklenir, istersen lobby:switchTeam ile değiştirir.
ipcMain.handle('lobby:join', async (e, { lobbyName, summonerName }) => {
    try {
        const lobby = await Lobby.findOne({ name: lobbyName });
        if (!lobby) return { success: false, message: 'Lobi bulunamadı' };
        if (lobby.players.find(p => p.name === summonerName))
            return { success: false, message: 'Zaten lobidesın' };
        lobby.players.push({ name: summonerName, isHost: false, team: 'BLUE', champion: null, locked: false, blowfishKey: generateBlowfishKey() });
        await lobby.save();
        const plain = lobby.toObject();
        broadcastLobbyUpdate(plain);
        broadcastLobbyListChanged();
        return { success: true, lobby: plain };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// Oyuncunun takımını değiştir (BLUE <-> PURPLE) — kalıcı, lobi odasındaki herkese yansır.
ipcMain.handle('lobby:switchTeam', async (e, { lobbyName, summonerName }) => {
    try {
        const lobby = await Lobby.findOne({ name: lobbyName });
        if (!lobby) return { success: false, message: 'Lobi bulunamadı' };

        const player = lobby.players.find(p => p.name === summonerName);
        if (!player) return { success: false, message: 'Oyuncu lobide değil' };

        player.team = player.team === 'BLUE' ? 'PURPLE' : 'BLUE';
        lobby.markModified('players');
        await lobby.save();

        const plain = lobby.toObject();
        broadcastLobbyUpdate(plain);
        return { success: true, lobby: plain };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// Mevcut lobinin en güncel halini getir (polling fallback / ilk yükleme için)
ipcMain.handle('lobby:getOne', async (e, { lobbyName }) => {
    try {
        const lobby = await Lobby.findOne({ name: lobbyName }).lean();
        if (!lobby) return { success: false, closed: true, message: 'Lobi bulunamadı' };
        return { success: true, lobby };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// main.js - friend:add handler
// main.js
// main.js - friend:add handler'ı
ipcMain.handle('friend:add', async (e, { currentUsername, friendSummonerName }) => {
    try {
        const recipient = await User.findOne({ summonerName: friendSummonerName });
        if (!recipient) return { success: false, message: 'Bu isimde bir sihirdar bulunamadı!' };

        await User.updateOne(
            { summonerName: friendSummonerName },
            { $push: { friendRequests: { from: currentUsername } } }
        );

        // --- BURAYI EKLE: Arayüze isteğin geldiğini bildir ---
        if (mainWindow) {
            mainWindow.webContents.send('socket:event', { 
                event: 'friend:request_received', 
                data: { from: currentUsername } 
            });
        }
        // -----------------------------------------------------

        return { success: true, message: 'İstek gönderildi!' };
    } catch (err) {
        return { success: false, message: err.message };
    }
});



// main.js

ipcMain.handle('friend:getList', async (e, { username }) => {
    // Add .lean() to the query to return a plain JavaScript object instead of a Mongoose document
    const user = await User.findOne({ username }).lean(); 
    
    return user ? user.friends : [];
});

ipcMain.handle('friend:accept', async (e, { currentUsername, requesterName }) => {
    try {
        // 1. Önce kabul eden kullanıcının kendi bilgilerini alalım (Karşı tarafa eklemek için summonerName'i lazım)
        const currentUserDoc = await User.findOne({ username: currentUsername });
        if (!currentUserDoc) {
            return { success: false, message: 'Kullanıcı veritabanında bulunamadı.' };
        }

        // 2. KABUL EDENİN (Kendi) Listesini Güncelle: İsteği sil ve arkadaşı listeye ekle
        await User.updateOne(
            { username: currentUsername },
            { 
                $pull: { friendRequests: { from: requesterName } },
                $push: { friends: { summonerName: requesterName, status: 'accepted' } }
            }
        );

        // 3. İSTEĞİ GÖNDERENİN (Karşı Tarafın) Listesini Güncelle: Kabul edeni ona arkadaş olarak ekle
        // requesterName arayüzden summonerName olarak geliyor (örnek: "arara")
        await User.updateOne(
            { summonerName: requesterName }, 
            { 
                $push: { friends: { summonerName: currentUserDoc.summonerName, status: 'accepted' } }
            }
        );

        return { success: true };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// Arkadaş isteğini reddetme
// main.js
ipcMain.handle('friend:reject', async (e, { currentUsername, requesterName }) => {
    try {
        await User.updateOne(
            { username: currentUsername },
            { $pull: { friendRequests: { from: requesterName } } }
        );
        return { success: true };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// İstekleri görüntülemek için handler
// main.js - DÜZELTİLMİŞ HALİ

// main.js - DÜZELTİLMİŞ HALİ

ipcMain.handle('friend:getRequests', async (e, { username }) => {
    try {
        // .lean() ekleyerek Mongoose'un karmaşık nesnesi yerine saf JSON objesi alıyoruz
        const user = await User.findOne({ username }).lean();
        
        // user null ise veya friends listesi boşsa güvenli dönüş
        return { success: true, requests: user ? (user.friendRequests || []) : [] };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// Socket Handler'lar
ipcMain.handle('socket:connect', (e, { host, port }) => {
    if (gameSocket) gameSocket.disconnect();
    gameSocket = io(`http://${host}:${port}`);
    gameSocket.onAny((ev, data) => mainWindow?.webContents.send('socket:event', { event: ev, data }));
    return { success: true };
});

ipcMain.handle('socket:send', (e, { eventName, data }) => gameSocket?.emit(eventName, data));

// ─────────────────────────────────────────────────────────────
// ŞAMPİYON SEÇİM EKRANI (UI İSKELETİ)
// Şimdilik gerçek zamanlama/pick mantığı BrokenWings game server'dan
// gelecek; burada sadece host'un "Start Game" demesiyle tüm lobi
// içindekilerin champselect.html'e geçmesini sağlıyoruz.
// BrokenWings entegre edildiğinde:
//   - champselect:start / pick / lock / end eventleri gameSocket üzerinden
//     dinlenip mainWindow'a iletilecek (socket-manager.js zaten bu eventleri
//     dinlemeye hazır, bkz. SERVER_EVENTS.CS_*)
//   - 'game:launch' handler'ı gerçek oyun process'ini (spawn) başlatacak
// ─────────────────────────────────────────────────────────────

// Host "Start Game" dedi — lobideki herkese champselect ekranına geçmesini bildir.
// NOT: Bu sadece champselect ekranını açar; gerçek oyun (game:launch) ancak
// lobideki HERKES şampiyonunu kilitleyince (lockChampion) otomatik tetiklenir.
ipcMain.handle('lobby:startGame', async (e, { lobbyName, summonerName }) => {
    try {
        // ID yerine isme göre aratıyoruz!
        const lobby = await Lobby.findOne({ name: lobbyName });
        
        if (!lobby) return { success: false, message: 'Lobi bulunamadı (İsim hatalı)' };
        if (lobby.host !== summonerName) return { success: false, message: 'Sadece host oyunu başlatabilir' };
        if (lobby.players.length < 1) return { success: false, message: 'Lobi boş' };

        // ChampSelect'e girerken herkesin seçim/kilit durumunu sıfırla
        lobby.players.forEach(p => { p.champion = null; p.locked = false; });
        lobby.markModified('players');
        lobby.status = 'ChampSelect';
        await lobby.save();
        const plain = lobby.toObject();

        if (mainWindow) {
            mainWindow.webContents.send('socket:event', {
                event: 'champselect:start',
                data: plain
            });
        }
        broadcastLobbyListChanged();
        return { success: true, lobby: plain };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// Bir oyuncu şampiyonunu kilitler (Lock In). Kilitlendikten sonra o oyuncu
// artık şampiyon değiştiremez (UI tarafında da disable edilir, burada da
// tekrar kilitlemeye izin verilmez). Lobideki TÜM oyuncular kilitlediğinde
// "allLocked: true" döner — renderer bunu görünce host/non-host fark etmeksizin
// kendi game:launch çağrısını tetikler (her oyuncu kendi makinesinde başlatır).
ipcMain.handle('champselect:lockChampion', async (e, { lobbyName, summonerName, champion }) => {
    try {
        const lobby = await Lobby.findOne({ name: lobbyName });
        if (!lobby) return { success: false, message: 'Lobi bulunamadı' };

        const player = lobby.players.find(p => p.name === summonerName);
        if (!player) return { success: false, message: 'Oyuncu lobide değil' };
        if (player.locked) return { success: false, message: 'Zaten kilitlendin' };
        if (!champion) return { success: false, message: 'Şampiyon seçilmedi' };

        player.champion = champion;
        player.locked = true;
        lobby.markModified('players');
        await lobby.save();

        const plain = lobby.toObject();
        const allLocked = plain.players.length > 0 && plain.players.every(p => p.locked === true);

        broadcastLobbyUpdate(plain);
        if (mainWindow) {
            mainWindow.webContents.send('socket:event', {
                event: 'champselect:lock',
                data: { lobby: plain, lockedBy: summonerName, allLocked }
            });
        }

        return { success: true, lobby: plain, allLocked };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// Şampiyon seçim ekranından çıkış (geri dön / iptal) — lobiyi tekrar Waiting yapar.
ipcMain.handle('lobby:cancelChampSelect', async (e, { lobbyName }) => {
    try {
        const lobby = await Lobby.findOne({ name: lobbyName });
        if (!lobby) return { success: false, message: 'Lobi bulunamadı' };
        lobby.status = 'Waiting';
        // İptal edilince herkesin seçim/kilit durumu sıfırlanır (sonraki
        // champselect turunda eski seçimler kalmasın).
        lobby.players.forEach(p => { p.champion = null; p.locked = false; });
        lobby.markModified('players');
        await lobby.save();
        const plain = lobby.toObject();
        if (mainWindow) {
            mainWindow.webContents.send('socket:event', { event: 'champselect:cancel', data: plain });
        }
        broadcastLobbyListChanged();
        return { success: true, lobby: plain };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

// game:launch artık iki moda ayrılıyor:
//  - HOST'un makinesinde: ChildrenOfTheGrave server'ı başlatır, GameInfo.json'a
//    LOBİDEKİ TÜM oyuncuları (alt alta, gerçek champion/team bilgileriyle) yazar,
//    ardından kendi League client'ını 127.0.0.1'e bağlar.
//  - Host olmayan oyuncuların makinesinde: server başlatılmaz, GameInfo.json
//    yazılmaz; sadece League client'ı lobi'de kayıtlı hostIp'ye bağlanacak
//    şekilde başlatılır.
ipcMain.handle('game:launch', async (e, data) => {
    try {
        console.log('[game:launch] Oyun başlatma tetiklendi. Veri:', data);

        // 1. Lobi bilgilerini çek
        const lobby = await Lobby.findOne({ name: data.lobbyName });
        if (!lobby) return { success: false, message: 'Lobi bulunamadı.' };

        const requestedName = data.summonerName || lobby.host;
        const isHostMachine = lobby.host === requestedName;
        const mapId = lobby.mapId;

        // 2. Yolları Belirle (config tanımlı değilse hata vermemesi için korumalı)
        const gamePath = (typeof config !== 'undefined' && config.gamePath) ? config.gamePath : "";
        if (!gamePath) return { success: false, message: 'Oyun dizini (config) bulunamadı!' };

        const exePath = path.join(gamePath, 'League of Legends.exe');
        if (!fs.existsSync(exePath)) return { success: false, message: 'Oyun .exe dosyası bulunamadı: ' + exePath };

        // Bağlanılacak sunucu adresi: host'un makinesindeysek localhost yeterli,
        // değilsek lobide kayıtlı hostIp kullanılır.
        const connectIp = isHostMachine ? '127.0.0.1' : (lobby.hostIp || '127.0.0.1');

        // playerId: GameInfo.json'daki playersPayload tam olarak lobby.players
        // sırasıyla (idx + 1) oluşturuluyor; client'ın bağlanırken kullandığı
        // playerId de bununla BİREBİR aynı olmalı, yoksa iki oyuncu da sabit
        // "1" ile bağlanmaya çalışıp aynı slotu paylaşıyordu.
        const myIndex = lobby.players.findIndex(p => p.name === requestedName);
        const myPlayerId = myIndex >= 0 ? myIndex + 1 : 1;
        const myPlayer = myIndex >= 0 ? lobby.players[myIndex] : null;
        // BrokenWings server'ı her oyuncuyu KENDİ blowfishKey'iyle eşleştiriyor
        // (bkz. Program.cs -> Game.Config.Players.First().BlowfishKey). Tüm
        // oyunculara aynı sabit anahtarı vermek host dışındaki oyuncuların
        // bağlantısının (ve dolayısıyla script/içerik senkronunun) düzgün
        // çalışmamasına yol açıyordu — artık lobiye katılırken/oluşturulurken
        // DB'ye kaydedilen, oyuncuya özel anahtar kullanılıyor.
        const myBlowfishKey = (myPlayer && myPlayer.blowfishKey) ? myPlayer.blowfishKey : "17BLOhi6KZsTtldTsizvHg==";

        // ─────────────────────────────────────────────
        // HOST DEĞİLSEK: sadece client'ı başlat, bitir.
        // ─────────────────────────────────────────────
        if (!isHostMachine) {
            // League of Legends.exe bağlantı bilgisini AYRI argümanlar olarak değil,
            // TEK bir boşlukla ayrılmış string olarak bekliyor (örn. .bat'taki
            // start "" "League of Legends.exe" "" "" "" "IP PORT KEY PLAYERID" gibi).
            // Ayrı ayrı argüman dizisi verilirse PlayerID kısmı doğru okunmuyor ve
            // bağlantı kurulamıyordu.
            const connectArg = `${connectIp} 5119 ${myBlowfishKey} ${myPlayerId}`;
            const gameProcess = spawn(exePath, ["", "", "", connectArg], { cwd: gamePath, detached: false, stdio: 'inherit' });
            gameProcess.on('error', console.error);
            gameProcess.on('exit', code => console.log('Exit:', code));
            console.log('[game:launch] Client (host olmayan) başlatıldı ->', connectArg);
            return { success: true };
        }

        // ─────────────────────────────────────────────
        // HOST İSEK: server + GameInfo.json (tüm oyuncular) + client
        // ─────────────────────────────────────────────

        // Sunucu yolu artık sabit kodlu değil — ayarlar ekranından (index.html)
        // seçilip config.serverPath'te saklanan klasör kullanılıyor. Bu klasör
        // doğrudan ChildrenOfTheGraveServerConsole.exe'nin bulunduğu yer olmalı
        // (örn. .../ChildrenOfTheGraveServerConsole/bin/Release/net9.0).
        const serverBaseDir = (typeof config !== 'undefined' && config.serverPath) ? config.serverPath : "";
        if (!serverBaseDir) return { success: false, message: 'Server dizini (config.serverPath) ayarlanmamış! Ayarlar ekranından seçin.' };

        const serverExePath = path.join(serverBaseDir, "ChildrenOfTheGraveServerConsole.exe");
        const settingsDir = path.join(serverBaseDir, "Settings");
        const gameInfoPath = path.join(settingsDir, "GameInfo.json");

        if (!fs.existsSync(serverExePath)) return { success: false, message: 'Server .exe dosyası bulunamadı: ' + serverExePath };

        // 3. Server'ı Başlat
        console.log('[game:launch] Server başlatılıyor...');
        const serverProcess = spawn(serverExePath, [], {
            cwd: path.dirname(serverExePath),
            detached: false,
            stdio: 'inherit',
            env: process.env
        });
        serverProcess.on('error', (err) => console.error('[SERVER SPAWN ERROR]', err));
        serverProcess.on('exit', (code) => console.log('[SERVER EXIT]', code));
        serverProcess.unref();

        // 4. GameInfo.json Hazırla — lobideki TÜM oyuncular alt alta eklenir
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }

        const baseTalents = {
            "100": 3, "101": 1, "102": 4, "103": 3, "104": 3, "106": 3, "107": 1,
            "115": 2, "116": 2, "123": 1, "134": 2, "137": 2, "139": 1, "143": 1, "146": 1
        };
        const baseRunes = {
            "1": 5245, "2": 5245, "3": 5245, "4": 5245, "5": 5245, "6": 5245, "7": 5245, "8": 5245, "9": 5245,
            "10": 5317, "11": 5317, "12": 5317, "13": 5317, "14": 5317, "15": 5317, "16": 5317, "17": 5317, "18": 5317,
            "19": 5289, "20": 5289, "21": 5289, "22": 5289, "23": 5289, "24": 5289, "25": 5289, "26": 5289, "27": 5289,
            "28": 5335, "29": 5335, "30": 5335
        };

        // Her lobi oyuncusunu GameInfo.json formatına çevir. Kilitlenmemiş
        // (locked=false) bir oyuncu teorik olarak buraya gelmemeli çünkü
        // lockChampion handler'ı zaten herkes kilitlenmeden launch'ı tetiklemiyor;
        // yine de güvenli varsayım olarak "Nunu" kullanıyoruz.
        // blowfishKey artık oyuncuya özel (lobiye katılırken/oluşturulurken
        // üretilip DB'ye kaydedilen anahtar) — sabit ortak anahtar değil.
        const playersPayload = lobby.players.map((p, idx) => ({
            "blowfishKey": p.blowfishKey || "17BLOhi6KZsTtldTsizvHg==",
            "rank": "UNRANKED",
            "champion": p.champion || "Nunu",
            "team": p.team === 'PURPLE' ? 'PURPLE' : 'BLUE',
            "skin": 0,
            "summoner1": "SummonerFlash",
            "summoner2": "SummonerDot",
            "ribbon": 2,
            "talents": baseTalents,
            "runes": baseRunes,
            "name": p.name,
            "icon": 0,
            "playerId": idx + 1
        }));

        const updatedGameInfo = {
            "gameId": 0,
            "game": {
                "map": mapId,
                "gameMode": "CLASSIC",
                "mutators": ["", "", "", "", "", "", "", ""],
                "dataPackage": "AvCsharp-Scripts"
            },
            "gameInfo": {
                "IS_DAMAGE_TEXT_GLOBAL": false,
                "CHEATS_ENABLED": true,
                "MANACOSTS_ENABLED": true,
                "COOLDOWNS_ENABLED": true,
                "MINION_SPAWNS_ENABLED": true,
                "TICK_RATE": 30,
                "FORCE_START_TIMER": 60,
                "SUPRESS_SCRIPT_NOT_FOUND_LOGS": true,
                "ENDGAME_HTTP_POST_ADDRESS": "",
                "CONTENT_PATH": "../../../../Content",
                "CLIENT_VERSION": "1.0.0.126",
                "KEEP_ALIVE_WHEN_EMPTY": false,
                "DEPLOY_FOLDER": "",
                "APIKEYDROPBOX": "",
                "USERNAMEOFREPLAYMAN": "",
                "PASSWORDOFREPLAYMAN": "",
                "ENABLE_LAUNCHER": false,
                "LAUNCHER_ADRESS_AND_PORT": "",
                "AB_CLIENT": false,
                "ENABLE_LOG_AND_CONSOLEWRITELINE": false,
                "ENABLE_LOG_BehaviourTree": false,
                "ENABLE_LOG_PKT": false,
                "ENABLE_REPLAY": false,
                "ENABLE_ALLOCATION_TRACKER": false,
                "SCRIPT_ASSEMBLIES": ["AvLua-Converted", "AvCsharp-Scripts"]
            },
            "players": playersPayload
        };

        fs.writeFileSync(gameInfoPath, JSON.stringify(updatedGameInfo, null, 2), 'utf8');
        console.log(`[BrokenWings] GameInfo.json başarıyla güncellendi (${playersPayload.length} oyuncu).`);

        // 5. Server'ın tam açılması için kısa bir bekleme (3 saniye)
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 6. Oyun Client'ını Başlat (host kendi localhost'una bağlanır)
        // Aynı sebepten (bkz. host olmayan dal): bağlantı bilgisi tek bir
        // boşlukla ayrılmış string olarak verilmeli, ayrı argümanlar değil.
        // playerId ve blowfishKey de sabit değil, lobby.players içindeki
        // gerçek değerlere (myPlayerId / myBlowfishKey) göre veriliyor —
        // bu, Program.cs'teki LaunchGameClient'ın Game.Config.Players.First()
        // ile aynı oyuncunun anahtarını kullanmasıyla birebir tutarlı.
        const connectArg = `127.0.0.1 5119 ${myBlowfishKey} ${myPlayerId}`;
        const gameProcess = spawn(exePath, ["", "", "", connectArg], { cwd: gamePath, detached: false, stdio: 'inherit' });
        gameProcess.on('error', console.error);
        gameProcess.on('exit', code => console.log('Exit:', code));
        console.log(exePath);
        console.log(connectArg);

        // 7. Oyun başarıyla başlatıldı: lobi listede görünmesin (ama silinmesin),
        // bu yüzden status'u InGame yapıyoruz. lobby:getAll zaten sadece
        // status:'Waiting' olanları döndürüyor.
        lobby.status = 'InGame';
        await lobby.save();
        broadcastLobbyListChanged();

        return { success: true };

    } catch (err) {
        console.error('[game:launch] KRİTİK HATA:', err);
        return { success: false, message: `Oyun başlatılamadı: ${err.message}` };
    }
});