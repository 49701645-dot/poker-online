'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// CONSTANTS
// ============================================================
const MAX_PLAYERS = 7;
const MIN_PLAYERS = 2;
const TURN_TIMEOUT = 60000;
const RECONNECT_TIMEOUT = 15000;
const DEFAULT_STACK = 1000;
const REVIVE_STACK = 500;
const REVIVE_VOTE_TIME = 20000;
const ACTION_COOLDOWN = 250;
const SHOWDOWN_DELAY = 8000;
const CHAT_COOLDOWN = 1000;
const MAX_MSG_LEN = 200;
const MAX_NAME_LEN = 20;

// ============================================================
// CARD ENGINE
// ============================================================
const SUITS = ['s','h','d','c'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RANK_VAL = {};
RANKS.forEach((r,i) => RANK_VAL[r] = i + 2);

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardRank(c) { return (typeof c === 'string' && c.length >= 2) ? RANK_VAL[c[0]] : 0; }
function cardSuit(c) { return (typeof c === 'string' && c.length >= 2) ? c[1] : ''; }

function bestHand(cards) {
  if (cards.length < 5) return null;
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluateHand(combo);
    if (!score) continue;
    if (!best || compareScores(score, best.score) > 0) {
      best = { cards: combo, score };
    }
  }
  return best;
}

function bestHandExact(cards) {
  if (!cards || cards.length !== 5) return null;
  const score = evaluateHand(cards);
  return score ? { cards, score } : null;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function evaluateHand(five) {
  if (!Array.isArray(five) || five.length !== 5 || five.some(c => typeof c !== 'string' || c.length < 2 || !RANK_VAL[c[0]] || !SUITS.includes(c[1]))) return null;
  const ranks = five.map(cardRank).sort((a,b) => b - a);
  const suits = five.map(cardSuit);
  const flush = suits.every(s => s === suits[0]);
  const straight = isStraight(ranks);
  const straightHigh = straight ? getStraightHigh(ranks) : 0;

  const freq = {};
  for (const r of ranks) freq[r] = (freq[r]||0)+1;
  const counts = Object.values(freq).sort((a,b)=>b-a);
  const groups = Object.entries(freq).sort((a,b)=>b[1]-a[1]||b[0]-a[0]);

  if (flush && straight) {
    if (straightHigh === 14) return [9, straightHigh];
    return [8, straightHigh];
  }
  if (counts[0] === 4) {
    const quad = +groups[0][0], kick = +groups[1][0];
    return [7, quad, kick];
  }
  if (counts[0] === 3 && counts[1] === 2) {
    const trip = +groups[0][0], pair = +groups[1][0];
    return [6, trip, pair];
  }
  if (flush) return [5, ...ranks];
  if (straight) return [4, straightHigh];
  if (counts[0] === 3) {
    const trip = +groups[0][0];
    const kickers = groups.slice(1).map(g=>+g[0]).sort((a,b)=>b-a);
    return [3, trip, ...kickers];
  }
  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = groups.filter(g=>g[1]===2).map(g=>+g[0]).sort((a,b)=>b-a);
    const kick = groups.find(g=>g[1]===1);
    return [2, pairs[0], pairs[1], kick ? +kick[0] : 0];
  }
  if (counts[0] === 2) {
    const pair = +groups[0][0];
    const kickers = groups.slice(1).map(g=>+g[0]).sort((a,b)=>b-a);
    return [1, pair, ...kickers];
  }
  return [0, ...ranks];
}

function isStraight(sortedRanks) {
  const unique = [...new Set(sortedRanks)];
  if (unique.length < 5) return false;
  if (unique[0] - unique[4] === 4) return true;
  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) return true;
  return false;
}

function getStraightHigh(sortedRanks) {
  const unique = [...new Set(sortedRanks)];
  if (unique[0] === 14 && unique[1] === 5) return 5;
  return unique[0];
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function handName(score) {
  const names = ['Carta Alta','Par','Doble Par','Trío','Escalera','Color','Full House','Póker','Escalera de Color','Escalera Real'];
  return names[score[0]] || 'Desconocida';
}

// ============================================================
// ROOMS STORAGE
// ============================================================
const rooms = new Map();
const socketToRoom = new Map();
const socketToPlayer = new Map();
const bannedPlayers = new Map();

// ============================================================
// FACTORIES
// ============================================================
function createRoom(id, name, hostId, hostName, password, maxPlayers, startingStack, gameMode) {
  return {
    id, name, hostId,
    hostSocketId: hostId,
    password: password || '',
    maxPlayers: Math.min(Math.max(parseInt(maxPlayers)||6, MIN_PLAYERS), MAX_PLAYERS),
    startingStack: Math.max(parseInt(startingStack)||DEFAULT_STACK, 100),
    players: [], spectators: [],
    state: 'waiting',
    hasStarted: false,
    gameState: null,
    gameMode: gameMode === 'classic' ? 'classic' : 'texas',
    createdAt: Date.now(),
    settings: {
      allowRevive: true,
      reviveStack: REVIVE_STACK,
      requireReviveVote: true,
      allowSpectators: true,
      closeOnHostLeave: false,
      smallBlind: 100,
      bigBlind: 200,
      turnTimeout: TURN_TIMEOUT,
      chatMode: 'full',
      maxCardsChange: 3,
      showRivalStacksOnTable: false,
      compactMode: false,
      reducedAnimations: false,
      audioEnabled: true
    },
    paused: false,
    closeTimer: null,
    handLog: [],
    lastHandLog: []
  };
}

function createPlayer(socketId, name, stack, profile={}, sessionToken='') {
  const safeProfile = sanitizeProfile(profile);
  return {
    id: socketId,
    sessionToken: sanitizeSessionToken(sessionToken),
    name: sanitize(name),
    avatarId: safeProfile.avatarId,
    emotes: safeProfile.emotes,
    stack, bet: 0, totalBet: 0,
    cards: [],
    folded: false, allIn: false,
    disconnected: false, eliminated: false, left: false, pendingRemoval: false, status: 'active',
    seatIndex: -1,
    lastAction: 0, lastChat: 0,
    waitingNextHand: false,
    cardsSelected: [], hasExchanged: false,
    actedThisRound: false,
    lastActionBet: 0,
    _removalTimer: null
  };
}

function sanitize(str) {
  if (typeof str !== 'string') return 'Player';
  return str.replace(/[<>&"'`]/g, '').trim().slice(0, MAX_NAME_LEN) || 'Player';
}

function sanitizeSessionToken(token) {
  if (typeof token !== 'string') return '';
  return token.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function sanitizeMsg(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/</g,'&lt;').replace(/>/g,'&gt;').trim().slice(0, MAX_MSG_LEN);
}


const ALLOWED_AVATARS = new Set(['initial','orion','onyx','velvet','blanca','verde','roja','senior','noche']);
const ALLOWED_EMOTES = new Map([
  ['paso','PASO'], ['pago','PAGO'], ['subo','SUBO'], ['allin','ALL IN'],
  ['farol','FAROL'], ['buena','BUENA MANO'], ['mala','MALA SUERTE'], ['gg','GG']
]);
function sanitizeProfile(profile) {
  const raw = profile && typeof profile === 'object' ? profile : {};
  const avatarId = ALLOWED_AVATARS.has(raw.avatarId) ? raw.avatarId : 'initial';
  const emotes = Array.isArray(raw.emotes) ? raw.emotes.filter(id => ALLOWED_EMOTES.has(id)).slice(0,4) : ['paso','pago','subo','allin'];
  return { avatarId, emotes: emotes.length ? emotes : ['paso','pago','subo','allin'] };
}

function validateNumber(val, min, max) {
  const n = parseInt(val);
  if (isNaN(n) || !isFinite(n) || n < min || n > max) return null;
  return n;
}

// ============================================================
// GAME STATE FACTORY
// ============================================================
function createGameState(room) {
  const sb = room.settings.smallBlind || 100;
  const bb = room.settings.bigBlind || 200;
  return {
    deck: shuffle(createDeck()),
    discardPile: [],
    communityCards: [],
    pot: 0, sidePots: [],
    currentPlayerIndex: -1,
    dealerIndex: -1,
    smallBlindIndex: -1, bigBlindIndex: -1,
    phase: 'waiting',
    smallBlind: sb, bigBlind: bb,
    currentBet: 0, minRaise: bb,
    lastRaiseIndex: -1, actionCount: 0,
    turnTimer: null, nextHandTimer: null, handNumber: 0,
    reviveRequest: null,
    exchangeOrder: [], exchangeIndex: 0,
    showCardsIds: []
  };
}

// ============================================================
// BROADCAST HELPERS
// ============================================================
function broadcastRoomList() {
  io.emit('roomList', getRoomList());
}

function getRoomList() {
  return Array.from(rooms.values()).map(r => ({
    id: r.id, name: r.name,
    players: r.players.filter(p=>!p.disconnected && p.stack > 0).length,
    maxPlayers: r.maxPlayers,
    hasPassword: !!r.password,
    state: r.state,
    spectators: r.spectators.length,
    avgStack: getAvgStack(r),
    started: r.state === 'playing',
    gameMode: r.gameMode || 'texas'
  }));
}

function getAvgStack(room) {
  const active = room.players.filter(p=>!p.disconnected && p.stack > 0);
  if (!active.length) return 0;
  return Math.round(active.reduce((s,p)=>s+p.stack,0)/active.length);
}

function emitRoomState(room) {
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.id);
    if (!socket) continue;
    socket.emit('gameState', buildGameStateFor(room, player.id));
  }
  for (const spec of room.spectators) {
    const socket = io.sockets.sockets.get(spec.id);
    if (!socket) continue;
    socket.emit('gameState', buildGameStateFor(room, spec.id, true));
  }
}

function buildGameStateFor(room, socketId, isSpectator=false) {
  const gs = room.gameState;
  const phase = gs ? gs.phase : 'waiting';

  const players = room.players.map(p => {
    const isMe = p.id === socketId;
    let cards = [];
    if (gs && phase === 'showdown') {
      cards = (isMe || (gs.showCardsIds || []).includes(p.id)) ? p.cards : p.cards.map(() => 'back');
    } else if (isMe) {
      cards = p.cards;
    } else {
      cards = p.cards.map(() => 'back');
    }

    let status = p.status || 'active';
    if (p.disconnected) status = 'disconnected';
    else if (p.eliminated) status = (p.status === 'revivedNextHand') ? 'revivedNextHand' : 'busted';
    else if (p.allIn) status = 'allin';
    else if (p.stack <= 0) status = 'busted';
    else if (p.folded && !p.waitingNextHand) status = 'folded';
    else if (p.waitingNextHand) status = 'waiting';

    return {
      id: p.id, name: p.name, avatarId: p.avatarId || 'initial', emotes: p.emotes || [],
      stack: p.stack, bet: p.bet, totalBet: p.totalBet,
      cards,
      folded: p.folded, allIn: p.allIn,
      disconnected: p.disconnected, eliminated: p.eliminated, left: !!p.left,
      seatIndex: p.seatIndex,
      isHost: p.id === room.hostSocketId,
      waitingNextHand: !!p.waitingNextHand,
      status,
      cardsSelected: isMe && gs && gs.phase === 'exchange' ? (p.cardsSelected || []) : [],
      hasExchanged: !!p.hasExchanged,
      canRaise: gs ? canPlayerRaise(room, p) : false
    };
  });

  const gsData = gs ? {
    communityCards: gs.communityCards,
    pot: gs.pot, sidePots: (gs.sidePots || []).map(sp => ({ amount: sp.amount, eligibleIds: (sp.eligible || []).map(p => p.id) })),
    currentPlayerIndex: gs.currentPlayerIndex,
    dealerIndex: gs.dealerIndex,
    smallBlindIndex: gs.smallBlindIndex,
    bigBlindIndex: gs.bigBlindIndex,
    phase: gs.phase,
    smallBlind: gs.smallBlind, bigBlind: gs.bigBlind,
    currentBet: gs.currentBet, minRaise: gs.minRaise,
    handNumber: gs.handNumber,
    reviveRequest: gs.reviveRequest,
    exchangePlayerIndex: gs.phase === 'exchange' ? gs.exchangeOrder[gs.exchangeIndex] : null,
    currentPlayerId: room.players[gs.currentPlayerIndex]?.id || null,
    dealerId: room.players[gs.dealerIndex]?.id || null,
    smallBlindId: room.players[gs.smallBlindIndex]?.id || null,
    bigBlindId: room.players[gs.bigBlindIndex]?.id || null,
    exchangePlayerId: gs.phase === 'exchange' ? (room.players[gs.exchangeOrder[gs.exchangeIndex]]?.id || null) : null
  } : null;

  return {
    roomId: room.id, roomName: room.name,
    hostId: room.hostSocketId,
    state: room.state,
    gameMode: room.gameMode || 'texas',
    settings: room.settings,
    paused: !!room.paused,
    lastHandLog: room.lastHandLog || [],
    players,
    spectators: room.spectators.map(s=>({id:s.id,name:s.name,avatarId:s.avatarId||'initial'})),
    myId: socketId, isSpectator,
    gameState: gsData
  };
}

function cleanUiText(msg) {
  return String(msg || '').replace(/\s{2,}/g, ' ').trim();
}
function emitLog(room, msg, type='info') {
  const text = cleanUiText(msg);
  const payload = { system: true, text, type, ts: Date.now() };
  if (room) {
    room.handLog = room.handLog || [];
    room.handLog.push({ text, type, ts: payload.ts });
    if (room.handLog.length > 80) room.handLog.shift();
  }
  io.to(room.id).emit('chatMessage', payload);
}

// ============================================================
// ROOM CLOSE
// ============================================================
function cancelRoomClose(room) {
  if (room?.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; }
}
function scheduleRoomClose(room, reason, delay) {
  if (!room || !rooms.has(room.id)) return;
  cancelRoomClose(room);
  room.closeTimer = setTimeout(() => {
    room.closeTimer = null;
    if (rooms.has(room.id)) closeRoom(room, reason);
  }, delay);
}
function closeRoom(room, reason='La sala fue cerrada.') {
  if (!room || !rooms.has(room.id)) return false;
  clearTurnTimer(room);
  cancelRoomClose(room);
  if (room.gameState?.nextHandTimer) { clearTimeout(room.gameState.nextHandTimer); room.gameState.nextHandTimer = null; }
  io.to(room.id).emit('gameEnded', { reason });
  for (const p of room.players) {
    if (p._removalTimer) clearTimeout(p._removalTimer);
    socketToRoom.delete(p.id);
    socketToPlayer.delete(p.id);
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.leave(room.id);
  }
  for (const sp of room.spectators) {
    socketToRoom.delete(sp.id);
    const sock = io.sockets.sockets.get(sp.id);
    if (sock) sock.leave(room.id);
  }
  if (bannedPlayers.has(room.id)) bannedPlayers.delete(room.id);
  rooms.delete(room.id);
  broadcastRoomList();
  return true;
}

// ============================================================
// GAME LOGIC
// ============================================================
function startGame(room) {
  const activePlayers = room.players.filter(p => !p.eliminated && !p.disconnected && !p.left && p.stack > 0);
  if (activePlayers.length < MIN_PLAYERS) {
    emitLog(room, 'Se necesitan al menos 2 jugadores con fichas para iniciar.', 'error');
    return;
  }

  room.state = 'playing';
  room.hasStarted = true;
  room.gameState = createGameState(room);

  for (const p of room.players) {
    p.folded = false; p.allIn = false;
    if (!p.eliminated && p.stack > 0 && !p.disconnected) p.status = 'active';
    p.bet = 0; p.totalBet = 0; p.cards = [];
    p.hasExchanged = false; p.cardsSelected = [];
  }

  emitLog(room, `Partida iniciada: Modo: ${room.gameMode === 'classic' ? 'Póker Clásico (5 cartas)' : 'Texas Hold\'em'}`, 'success');
  startNewHand(room);
  broadcastRoomList();
}

function startNewHand(room) {
  if (!room.gameState) return;
  if (room.handLog && room.handLog.length) room.lastHandLog = room.handLog.slice(-80);
  room.handLog = [];
  room.paused = false;
  cancelRoomClose(room);
  const gs = room.gameState;
  clearTurnTimer(room);
  if (gs.nextHandTimer) { clearTimeout(gs.nextHandTimer); gs.nextHandTimer = null; }

  for (const p of room.players) {
    if (p.stack > 0 && !p.eliminated && !p.disconnected && !p.left) p.waitingNextHand = false;
    p.hasExchanged = false;
    p.cardsSelected = [];
  }

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.left && !p.waitingNextHand && p.stack > 0);
  if (active.length < MIN_PLAYERS) {
    if (room.hasStarted) {
      const reconnecting = room.players.filter(p => p.disconnected && !p.left && !p.eliminated && p.stack > 0);
      if (reconnecting.length > 0) {
        gs.phase = 'showdown';
        emitLog(room, 'Esperando reconexión de jugador(es) antes de continuar...', 'warning');
        emitRoomState(room);
        scheduleNextHand(room, RECONNECT_TIMEOUT + 250);
        return;
      }
      const busted = room.players.filter(p => p.eliminated && !p.disconnected && !p.left && room.settings.allowRevive);
      if (busted.length > 0 && active.length >= 1) {
        emitLog(room, 'Esperando posibles solicitudes de revive...', 'warning');
        gs.phase = 'showdown';
        emitRoomState(room);
        return;
      }
      const winner = active[0]?.name;
      const msg = winner ? `${winner} gana la partida. La sala se cerrará.` : 'La partida terminó. La sala se cerrará.';
      emitLog(room, msg, 'champion');
      scheduleRoomClose(room, msg, 1500);
    }
    return;
  }

  gs.handNumber++;
  gs.deck = shuffle(createDeck());
  gs.discardPile = [];
  gs.communityCards = [];
  gs.pot = 0; gs.sidePots = [];
  gs.currentBet = 0; gs.minRaise = gs.bigBlind;
  gs.lastRaiseIndex = -1; gs.actionCount = 0;
  gs.reviveRequest = null;
  gs.exchangeOrder = []; gs.exchangeIndex = 0;
  gs.showCardsIds = [];

  for (const p of room.players) {
    p.folded = p.eliminated || p.disconnected || p.left || p.waitingNextHand || p.stack <= 0;
    p.status = p.left ? 'left' : (p.disconnected ? 'disconnected' : (p.eliminated || p.stack <= 0 ? 'busted' : (p.waitingNextHand ? 'waiting' : 'active')));
    p.allIn = false; p.bet = 0; p.totalBet = 0; p.cards = [];
    p.actedThisRound = false; p.lastActionBet = 0;
  }

  // Advance the button exactly ONCE per hand.
  gs.dealerIndex = getNextActiveIndex(room, gs.dealerIndex);
  const activePl = room.players.filter(p => !p.folded);
  const nActive = activePl.length;

  let sbIdx, bbIdx;
  if (nActive === 2) {
    sbIdx = gs.dealerIndex;
    bbIdx = getNextActiveIndex(room, sbIdx);
  } else {
    sbIdx = getNextActiveIndex(room, gs.dealerIndex);
    bbIdx = getNextActiveIndex(room, sbIdx);
  }
  gs.smallBlindIndex = sbIdx;
  gs.bigBlindIndex = bbIdx;

  const sbPlayer = room.players[sbIdx];
  const bbPlayer = room.players[bbIdx];
  postBlind(sbPlayer, gs, gs.smallBlind);
  postBlind(bbPlayer, gs, gs.bigBlind);
  // A short all-in blind does not reduce the blind obligation for other players.
  gs.currentBet = gs.bigBlind;
  gs.minRaise = gs.bigBlind;

  const cardsPerPlayer = room.gameMode === 'classic' ? 5 : 2;
  for (let i = 0; i < cardsPerPlayer; i++) {
    for (const p of room.players) if (!p.folded) p.cards.push(gs.deck.pop());
  }

  gs.phase = room.gameMode === 'classic' ? 'drawbet1' : 'preflop';
  initializeBettingRound(room, false);
  const first = nActive === 2 ? sbIdx : getNextActiveIndex(room, bbIdx);
  gs.currentPlayerIndex = first;

  emitLog(room, `Mano #${gs.handNumber} | Dealer: ${room.players[gs.dealerIndex]?.name} | SB: ${sbPlayer?.name} (${gs.smallBlind}) | BB: ${bbPlayer?.name} (${gs.bigBlind})`, 'info');
  resumeBettingOrAdvance(room, (first - 1 + room.players.length) % room.players.length);
}

function postBlind(player, gs, amount) {
  if (!player) return;
  const actual = Math.min(amount, player.stack);
  player.bet += actual; player.totalBet += actual;
  player.stack -= actual; gs.pot += actual;
  if (player.stack === 0) player.allIn = true;
}

function isSeatEligibleForNextHand(p) {
  return !!p && !p.eliminated && !p.disconnected && !p.left && !p.waitingNextHand && p.stack > 0;
}

function isHandLive(p) {
  return !!p && !p.folded && !p.eliminated && !p.left && !p.waitingNextHand && (!p.disconnected || p.allIn);
}

function canAct(p) {
  return isHandLive(p) && !p.allIn && !p.disconnected && p.stack > 0;
}

function getNextActiveIndex(room, fromIndex) {
  const n = room.players.length;
  if (!n) return -1;
  let idx = ((fromIndex + 1) % n + n) % n;
  for (let count = 0; count < n; count++) {
    const p = room.players[idx];
    if (isSeatEligibleForNextHand(p) || (room.gameState && room.gameState.phase !== 'waiting' && isHandLive(p))) return idx;
    idx = (idx + 1) % n;
  }
  return -1;
}

function getActivePlayers(room) {
  return room.players.filter(isHandLive);
}

function getActionPlayers(room) {
  return room.players.filter(canAct);
}

function initializeBettingRound(room, resetBets=true) {
  const gs = room.gameState;
  if (resetBets) {
    for (const p of room.players) p.bet = 0;
    gs.currentBet = 0;
  }
  gs.minRaise = gs.bigBlind;
  gs.lastRaiseIndex = -1;
  gs.actionCount = 0;
  for (const p of room.players) {
    p.actedThisRound = false;
    p.lastActionBet = gs.currentBet;
  }
}

function canPlayerRaise(room, player) {
  const gs = room.gameState;
  if (!gs || !canAct(player)) return false;
  if (!player.actedThisRound) return true;
  return (gs.currentBet - (player.lastActionBet || 0)) >= gs.minRaise;
}

function playerNeedsAction(room, p) {
  const gs = room.gameState;
  return canAct(p) && (!p.actedThisRound || p.bet < gs.currentBet);
}

function bettingRoundComplete(room) {
  const actionPlayers = getActionPlayers(room);
  if (actionPlayers.length === 0) return true;
  if (actionPlayers.length === 1) return actionPlayers[0].bet >= room.gameState.currentBet;
  return actionPlayers.every(p => p.actedThisRound && p.bet === room.gameState.currentBet);
}

function findNextActionIndex(room, fromIndex) {
  const n = room.players.length;
  if (!n) return -1;
  let idx = ((fromIndex + 1) % n + n) % n;
  for (let count = 0; count < n; count++) {
    if (playerNeedsAction(room, room.players[idx])) return idx;
    idx = (idx + 1) % n;
  }
  return -1;
}

function rejectAction(room, socketId, msg) {
  io.to(socketId).emit('error', { msg });
  const gs = room.gameState;
  if (gs && !room.paused && !['waiting','showdown'].includes(gs.phase)) {
    const currentId = gs.phase === 'exchange'
      ? room.players[gs.exchangeOrder[gs.exchangeIndex]]?.id
      : room.players[gs.currentPlayerIndex]?.id;
    if (currentId === socketId && !gs.turnTimer) startTurnTimer(room);
  }
  return false;
}

function startTurnTimer(room) {
  const gs = room.gameState;
  if (!gs || room.paused) return;
  clearTurnTimer(room);
  const timeout = room.settings.turnTimeout || TURN_TIMEOUT;

  if (gs.phase === 'exchange') {
    const exIdx = gs.exchangeOrder[gs.exchangeIndex];
    const currentPlayer = room.players[exIdx];
    if (!currentPlayer || !isHandLive(currentPlayer) || currentPlayer.hasExchanged) { proceedExchange(room); return; }
    gs.currentPlayerIndex = exIdx;
    io.to(room.id).emit('turnStart', { playerId: currentPlayer.id, timeout, ts: Date.now(), exchange: true });
    gs.turnTimer = setTimeout(() => {
      if (!rooms.has(room.id) || room.paused) return;
      const p = room.players[room.gameState?.exchangeOrder[room.gameState?.exchangeIndex]];
      if (p && !p.hasExchanged) {
        emitLog(room, `⏱️ ${p.name} no cambió cartas (tiempo agotado).`, 'warning');
        handleExchangeAction(room, p.id, 'exchange', []);
      }
    }, timeout);
    return;
  }

  const currentPlayer = room.players[gs.currentPlayerIndex];
  if (!currentPlayer || !playerNeedsAction(room, currentPlayer)) {
    resumeBettingOrAdvance(room, gs.currentPlayerIndex);
    return;
  }
  io.to(room.id).emit('turnStart', { playerId: currentPlayer.id, timeout, ts: Date.now() });
  gs.turnTimer = setTimeout(() => {
    if (!rooms.has(room.id) || room.paused) return;
    const p = room.players[room.gameState?.currentPlayerIndex];
    if (p && playerNeedsAction(room, p)) {
      const callAmount = Math.max(0, room.gameState.currentBet - p.bet);
      const autoAction = callAmount === 0 ? 'check' : 'fold';
      emitLog(room, `⏱️ ${p.name} agotó su tiempo. ${autoAction === 'check' ? 'Check' : 'Fold'} automático.`, 'warning');
      handleAction(room, p.id, autoAction, 0, true);
    }
  }, timeout);
}

function clearTurnTimer(room) {
  if (room.gameState?.turnTimer) {
    clearTimeout(room.gameState.turnTimer);
    room.gameState.turnTimer = null;
  }
}

function resumeBettingOrAdvance(room, fromIndex) {
  const gs = room.gameState;
  if (!gs || room.paused) return;
  clearTurnTimer(room);
  const live = getActivePlayers(room);
  if (live.length <= 1) { endHand(room); return; }
  if (bettingRoundComplete(room)) { advancePhase(room); return; }
  const nextIdx = findNextActionIndex(room, fromIndex);
  if (nextIdx < 0) { advancePhase(room); return; }
  gs.currentPlayerIndex = nextIdx;
  emitRoomState(room);
  startTurnTimer(room);
}

function handleAction(room, socketId, action, amount, isTimeout=false) {
  const gs = room.gameState;
  if (!gs) return false;
  if (room.paused) return rejectAction(room, socketId, 'La partida está pausada.');
  if (gs.phase === 'exchange') return rejectAction(room, socketId, 'Ahora toca cambiar cartas.');
  if (gs.phase === 'waiting' || gs.phase === 'showdown') return false;

  const curIdx = gs.currentPlayerIndex;
  const player = room.players[curIdx];
  if (!player || player.id !== socketId) return rejectAction(room, socketId, 'No es tu turno.');
  if (!playerNeedsAction(room, player)) return rejectAction(room, socketId, 'No podés actuar en este momento.');

  const now = Date.now();
  if (!isTimeout && now - player.lastAction < ACTION_COOLDOWN) return false;
  player.lastAction = now;

  const callAmount = Math.max(0, gs.currentBet - player.bet);
  let logType = 'info';
  let logText = '';
  let newCurrentBet = gs.currentBet;
  let fullRaise = false;

  switch (action) {
    case 'fold':
      player.folded = true;
      logType = 'fold'; logText = `${player.name} se fue al fold.`;
      break;

    case 'check':
      if (callAmount !== 0) return rejectAction(room, socketId, 'No podés hacer check: hay una apuesta pendiente.');
      logType = 'check'; logText = `${player.name} checkeó.`;
      break;

    case 'call': { // includes a short all-in call
      if (callAmount <= 0) return rejectAction(room, socketId, 'No hay nada que pagar.');
      const actual = Math.min(callAmount, player.stack);
      player.bet += actual; player.totalBet += actual; player.stack -= actual; gs.pot += actual;
      if (player.stack === 0) {
        player.allIn = true;
        logType = 'allin'; logText = `${player.name} paga ALL-IN con ${player.totalBet}.`;
      } else {
        logType = 'call'; logText = `${player.name} pagó ${actual}.`;
      }
      break;
    }

    case 'raise': {
      if (!canPlayerRaise(room, player)) return rejectAction(room, socketId, 'La acción no está reabierta para volver a subir.');
      const raiseAmount = validateNumber(amount, 1, 99999999);
      if (raiseAmount === null) return rejectAction(room, socketId, 'Monto de subida inválido.');
      if (raiseAmount < gs.minRaise) return rejectAction(room, socketId, `La subida mínima es ${gs.minRaise}.`);
      const needed = callAmount + raiseAmount;
      if (needed > player.stack) return rejectAction(room, socketId, 'No tenés fichas suficientes. Usá All-In.');
      player.bet += needed; player.totalBet += needed; player.stack -= needed; gs.pot += needed;
      newCurrentBet = player.bet;
      fullRaise = true;
      logType = player.stack === 0 ? 'allin' : 'raise';
      logText = player.stack === 0 ? `${player.name} va ALL-IN a ${newCurrentBet}.` : `⬆️ ${player.name} subió a ${newCurrentBet}.`;
      if (player.stack === 0) player.allIn = true;
      break;
    }

    case 'allin': {
      const shove = player.stack;
      if (shove <= 0) return false;
      const targetBet = player.bet + shove;
      if (targetBet > gs.currentBet && !canPlayerRaise(room, player)) {
        // With closed raise rights, an all-in may only call, not create a raise.
        if (shove > callAmount) return rejectAction(room, socketId, 'Tu acción no está reabierta: solo podés pagar o foldear.');
      }
      player.bet = targetBet; player.totalBet += shove; gs.pot += shove; player.stack = 0; player.allIn = true;
      if (targetBet > gs.currentBet) {
        const raiseSize = targetBet - gs.currentBet;
        newCurrentBet = targetBet;
        fullRaise = raiseSize >= gs.minRaise;
      }
      logType = 'allin'; logText = `${player.name} va ALL-IN con ${player.totalBet}!`;
      break;
    }

    default:
      return false;
  }

  if (newCurrentBet > gs.currentBet) {
    const raiseSize = newCurrentBet - gs.currentBet;
    gs.currentBet = newCurrentBet;
    if (fullRaise) {
      gs.minRaise = raiseSize;
      gs.lastRaiseIndex = curIdx;
      // A full raise reopens action for every other player still able to act.
      for (const other of room.players) if (other !== player && canAct(other)) other.actedThisRound = false;
    }
  }

  player.actedThisRound = true;
  player.lastActionBet = gs.currentBet;
  gs.actionCount++;
  emitLog(room, logText, logType);

  const live = getActivePlayers(room);
  if (live.length <= 1) { endHand(room); return true; }
  resumeBettingOrAdvance(room, curIdx);
  return true;
}

function scheduleAutoAdvance(room, delay=850) {
  const gs = room.gameState;
  clearTurnTimer(room);
  if (gs.nextHandTimer) clearTimeout(gs.nextHandTimer);
  emitRoomState(room);
  gs.nextHandTimer = setTimeout(() => {
    if (!rooms.has(room.id) || room.paused) return;
    gs.nextHandTimer = null;
    advancePhase(room);
  }, delay);
}

function advancePhase(room) {
  const gs = room.gameState;
  if (!gs) return;
  clearTurnTimer(room);

  if (room.gameMode === 'classic') {
    if (gs.phase === 'drawbet1') {
      for (const p of room.players) p.bet = 0;
      gs.currentBet = 0;
      startExchangePhase(room);
      return;
    }
    if (gs.phase === 'drawbet2') { endHand(room); return; }
    return;
  }

  for (const p of room.players) p.bet = 0;
  gs.currentBet = 0;
  gs.minRaise = gs.bigBlind;
  gs.lastRaiseIndex = -1;
  gs.actionCount = 0;

  switch (gs.phase) {
    case 'preflop':
      gs.phase = 'flop';
      gs.communityCards.push(gs.deck.pop(), gs.deck.pop(), gs.deck.pop());
      emitLog(room, `FLOP: ${gs.communityCards.join(' ')}`, 'phase');
      break;
    case 'flop':
      gs.phase = 'turn'; gs.communityCards.push(gs.deck.pop());
      emitLog(room, `TURN: ${gs.communityCards[3]}`, 'phase');
      break;
    case 'turn':
      gs.phase = 'river'; gs.communityCards.push(gs.deck.pop());
      emitLog(room, `RIVER: ${gs.communityCards[4]}`, 'phase');
      break;
    case 'river':
      endHand(room); return;
    default: return;
  }

  initializeBettingRound(room, false);
  const actionPlayers = getActionPlayers(room);
  if (actionPlayers.length <= 1) {
    // Nobody can make a meaningful bet against an opponent: run the board automatically.
    scheduleAutoAdvance(room);
    return;
  }
  const firstActor = findNextActionIndex(room, gs.dealerIndex);
  if (firstActor < 0) { scheduleAutoAdvance(room); return; }
  gs.currentPlayerIndex = firstActor;
  emitRoomState(room);
  startTurnTimer(room);
}

// ============================================================
// CLASSIC MODE — EXCHANGE PHASE
// ============================================================
function startExchangePhase(room) {
  const gs = room.gameState;
  gs.phase = 'exchange';
  clearTurnTimer(room);

  const ordered = [];
  let idx = gs.dealerIndex;
  for (let count = 0; count < room.players.length; count++) {
    idx = getNextActiveIndex(room, idx);
    if (idx < 0 || ordered.includes(idx)) break;
    const p = room.players[idx];
    if (isHandLive(p)) ordered.push(idx);
  }
  gs.exchangeOrder = ordered;
  gs.exchangeIndex = 0;
  for (const p of room.players) { p.cardsSelected = []; p.hasExchanged = false; }

  emitLog(room, `Fase de cambio. Máximo ${room.settings.maxCardsChange ?? 3} carta(s) por jugador.`, 'phase');
  proceedExchange(room);
}

function proceedExchange(room) {
  const gs = room.gameState;
  if (!gs || room.paused) return;
  clearTurnTimer(room);

  while (gs.exchangeIndex < gs.exchangeOrder.length) {
    const playerIdx = gs.exchangeOrder[gs.exchangeIndex];
    const player = room.players[playerIdx];
    if (player && isHandLive(player) && !player.hasExchanged) {
      if (player.disconnected) {
        player.hasExchanged = true;
        emitLog(room, `${player.name} está desconectado y no cambia cartas.`, 'warning');
        gs.exchangeIndex++;
        continue;
      }
      gs.currentPlayerIndex = playerIdx;
      emitRoomState(room);
      startTurnTimer(room);
      return;
    }
    gs.exchangeIndex++;
  }

  gs.phase = 'drawbet2';
  initializeBettingRound(room, true);
  emitLog(room, 'Segunda ronda de apuestas.', 'phase');

  if (getActionPlayers(room).length <= 1) {
    // With everyone else all-in, there is no second betting decision to make.
    endHand(room);
    return;
  }
  const firstActor = findNextActionIndex(room, gs.dealerIndex);
  if (firstActor < 0) { endHand(room); return; }
  gs.currentPlayerIndex = firstActor;
  emitRoomState(room);
  startTurnTimer(room);
}

function handleExchangeAction(room, socketId, action, cardIndices) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'exchange') return false;
  if (room.paused) return rejectAction(room, socketId, 'La partida está pausada.');

  const playerIdx = gs.exchangeOrder[gs.exchangeIndex];
  const player = room.players[playerIdx];
  if (!player || player.id !== socketId) return rejectAction(room, socketId, 'No es tu turno de cambiar cartas.');
  if (player.hasExchanged) return false;

  const maxChange = room.settings.maxCardsChange ?? 3;
  const raw = Array.isArray(cardIndices) ? cardIndices : [];
  const indices = [...new Set(raw.filter(i => Number.isInteger(i) && i >= 0 && i < 5))].slice(0, maxChange);
  const discardedNow = indices.map(i => player.cards[i]).filter(Boolean);

  // Draw first; only afterwards add this player's discards, preventing an immediate redraw of their own card.
  for (const idx of indices) {
    if (gs.deck.length === 0 && gs.discardPile.length) gs.deck = shuffle(gs.discardPile.splice(0));
    const replacement = gs.deck.pop();
    if (!replacement) {
      emitLog(room, 'No quedan cartas disponibles para completar el cambio.', 'error');
      break;
    }
    player.cards[idx] = replacement;
  }
  gs.discardPile.push(...discardedNow);
  player.hasExchanged = true;

  emitLog(room, indices.length ? `${player.name} cambió ${indices.length} carta(s).` : `${player.name} no cambió cartas.`, 'info');
  gs.exchangeIndex++;
  proceedExchange(room);
  return true;
}

// ============================================================
// SIDE POTS & SHOWDOWN
// ============================================================
function calculateSidePots(room) {
  const contributors = room.players.filter(p => p.totalBet > 0);
  if (!contributors.length) return [];
  const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a,b) => a-b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const layer = contributors.filter(p => p.totalBet >= level);
    const amount = (level - prev) * layer.length;
    const eligible = layer.filter(p => !p.folded);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

function endHand(room) {
  const gs = room.gameState;
  if (!gs || gs.phase === 'showdown') return;
  clearTurnTimer(room);
  if (gs.nextHandTimer) { clearTimeout(gs.nextHandTimer); gs.nextHandTimer = null; }
  gs.phase = 'showdown';
  gs.reviveRequest = null;

  const active = room.players.filter(p => !p.folded && p.cards.length > 0 && !p.left);
  const isClassic = room.gameMode === 'classic';
  const winners = [];
  const originalPot = gs.pot;
  gs.showCardsIds = active.length > 1 ? active.map(p => p.id) : [];

  if (active.length === 1) {
    active[0].stack += originalPot;
    emitLog(room, `${active[0].name} gana ${originalPot} fichas sin mostrar.`, 'win');
    winners.push({ player: active[0], amount: originalPot });
  } else if (active.length > 1) {
    const sidePots = calculateSidePots(room);
    gs.sidePots = sidePots;
    for (const pot of sidePots) {
      const handResults = pot.eligible.map(p => {
        const hand = isClassic ? bestHandExact(p.cards) : bestHand([...p.cards, ...gs.communityCards]);
        return { player: p, hand };
      }).filter(r => r.hand);
      if (!handResults.length) continue;
      handResults.sort((a,b) => compareScores(b.hand.score, a.hand.score));
      const best = handResults[0].hand.score;
      const potWinners = handResults.filter(r => compareScores(r.hand.score, best) === 0);
      const share = Math.floor(pot.amount / potWinners.length);
      let rem = pot.amount - share * potWinners.length;
      const orderedWinners = potWinners.slice().sort((a,b) => {
        const ai = room.players.indexOf(a.player), bi = room.players.indexOf(b.player), n = room.players.length || 1;
        const ad = (ai - gs.dealerIndex + n) % n || n;
        const bd = (bi - gs.dealerIndex + n) % n || n;
        return ad - bd;
      });
      for (const r of orderedWinners) {
        const extra = rem > 0 ? 1 : 0;
        if (rem > 0) rem--;
        const winAmt = share + extra;
        r.player.stack += winAmt;
        winners.push({ player: r.player, amount: winAmt, hand: handName(r.hand.score), cards: r.hand.cards });
        emitLog(room, `${r.player.name} gana ${winAmt} con ${handName(r.hand.score)}!`, 'win');
      }
    }
  }

  // Chips have already been paid; do not display a duplicated pot during the showdown overlay.
  gs.pot = 0;

  io.to(room.id).emit('showdown', {
    winners: winners.map(w => ({ id: w.player.id, name: w.player.name, amount: w.amount, hand: w.hand, cards: w.cards })),
    players: room.players.filter(p => !p.left).map(p => {
      const shown = gs.showCardsIds.includes(p.id);
      let handStr = '';
      if (shown) {
        const h = isClassic ? bestHandExact(p.cards) : bestHand([...p.cards, ...gs.communityCards]);
        handStr = h ? handName(h.score) : '';
      }
      return { id: p.id, name: p.name, cards: shown ? p.cards : [], hand: handStr, mucked: !shown };
    })
  });

  // Players who left while all-in keep their hand alive through payout, then leave the table.
  for (const p of room.players) {
    if (p.pendingRemoval && p.disconnected) {
      p.left = true; p.eliminated = true; p.status = 'left'; p.allIn = false;
    }
  }

  // Mark busted players now, while preserving committed bets/cards until this showdown is finished.
  for (const p of room.players) {
    if (!p.eliminated && !p.left && p.stack <= 0 && !p.disconnected) {
      p.eliminated = true; p.status = 'busted'; p.allIn = false; p.waitingNextHand = true;
      emitLog(room, `${p.name} quedó sin fichas. Puede mirar y pedir revive.`, 'eliminate');
      io.to(p.id).emit('eliminated');
    }
  }
  emitRoomState(room);

  const remaining = room.players.filter(p => !p.eliminated && !p.left && p.stack > 0);
  if (remaining.length < MIN_PLAYERS) {
    const busted = room.players.filter(p => p.eliminated && !p.disconnected && !p.left && room.settings.allowRevive);
    if (busted.length > 0 && remaining.length >= 1) {
      emitLog(room, `⏸️ Queda ${remaining[0].name} con fichas. Esperando posibles solicitudes de revive.`, 'warning');
      return;
    }
    if (remaining.length === 1) {
      emitLog(room, `${remaining[0].name} gana la partida!`, 'champion');
      io.to(room.id).emit('gameOver', { winner: remaining[0].name });
      scheduleRoomClose(room, `${remaining[0].name} ganó la partida.`, 3500);
    } else {
      scheduleRoomClose(room, 'La partida terminó.', 1500);
    }
    return;
  }

  scheduleNextHand(room, SHOWDOWN_DELAY);
}

function scheduleNextHand(room, delay=SHOWDOWN_DELAY) {
  const gs = room.gameState;
  if (!gs) return;
  if (gs.nextHandTimer) clearTimeout(gs.nextHandTimer);
  gs.nextHandTimer = setTimeout(() => {
    if (!rooms.has(room.id)) return;
    gs.nextHandTimer = null;
    startNewHand(room);
  }, delay);
}

// ============================================================
// REVIVE SYSTEM
// ============================================================
function requestRevive(room, socketId) {
  cancelRoomClose(room);
  if (!room.settings.allowRevive) return rejectAction(room, socketId, 'El revive está desactivado en esta sala.');
  const gs = room.gameState;
  if (!gs || gs.reviveRequest) return;
  const player = room.players.find(p => p.id === socketId && p.eliminated && !p.left);
  if (!player) return;
  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.left && p.stack > 0);
  if (!active.length) return;

  if (!room.settings.requireReviveVote) {
    gs.reviveRequest = { playerId: socketId, playerName: player.name, votes: {}, expiresAt: Date.now() };
    resolveReviveVote(room, false, true);
    return;
  }

  gs.reviveRequest = { playerId: socketId, playerName: player.name, votes: {}, expiresAt: Date.now() + REVIVE_VOTE_TIME };
  emitLog(room, `${player.name} solicita revivir. ¡Voten!`, 'revive');
  emitRoomState(room);
  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    if (room.gameState?.reviveRequest?.playerId === socketId) resolveReviveVote(room, true);
  }, REVIVE_VOTE_TIME + 100);
}

function voteRevive(room, socketId, vote) {
  const gs = room.gameState;
  if (!gs || !gs.reviveRequest) return;
  const voter = room.players.find(p => p.id === socketId && !p.eliminated && !p.disconnected);
  if (!voter) return;

  gs.reviveRequest.votes[socketId] = vote;
  emitRoomState(room);

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && p.stack > 0);
  const voted = active.filter(p => gs.reviveRequest.votes[p.id] !== undefined);
  if (voted.length >= active.length) resolveReviveVote(room, false);
}

function resolveReviveVote(room, timeout, autoApprove=false) {
  const gs = room.gameState;
  if (!gs || !gs.reviveRequest) return;
  const req = gs.reviveRequest;
  gs.reviveRequest = null;

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.left && p.stack > 0);
  const yesVotes = active.filter(p => req.votes[p.id] === true).length;
  const majority = autoApprove || yesVotes > active.length / 2;

  if (majority) {
    const player = room.players.find(p => p.id === req.playerId && !p.left);
    if (player) {
      player.eliminated = false;
      player.status = 'revivedNextHand';
      const revStack = room.settings.reviveStack || REVIVE_STACK;
      player.stack = revStack; player.folded = true; player.allIn = false;
      player.waitingNextHand = true; player.cards = [];
      emitLog(room, `${player.name} revivió con ${revStack} fichas! Jugará la próxima mano.`, 'revive');
      io.to(player.id).emit('revived', { stack: revStack });
      if (gs.phase === 'waiting' || gs.phase === 'showdown') scheduleNextHand(room, SHOWDOWN_DELAY);
    }
  } else {
    emitLog(room, timeout ? `Votación finalizada: ${req.playerName} no obtuvo mayoría para revivir.` : `No aprobado: ${req.playerName} no obtuvo suficientes votos para revivir.`, 'info');
  }
  emitRoomState(room);
}

// ============================================================
// HOST ACTIONS (all validated server-side)
// ============================================================
function assertHost(room, socketId) {
  if (room.hostSocketId !== socketId) {
    io.to(socketId).emit('error', { msg: 'Solo el anfitrión puede hacer eso.' });
    return false;
  }
  return true;
}

function kickPlayer(room, hostSocketId, targetId) {
  if (!assertHost(room, hostSocketId)) return false;
  if (targetId === hostSocketId) return false;
  const target = room.players.find(p => p.id === targetId);
  if (!target) return false;
  emitLog(room, `${target.name} fue expulsado.`, 'kick');
  io.to(targetId).emit('kicked', { reason: 'Fuiste expulsado por el anfitrión.' });
  removePlayerFromRoom(room, targetId, false);
  return true;
}

function banPlayer(room, hostSocketId, targetId) {
  if (!assertHost(room, hostSocketId)) return false;
  if (targetId === hostSocketId) return false;
  const target = room.players.find(p => p.id === targetId);
  if (!target) return false;
  if (!bannedPlayers.has(room.id)) bannedPlayers.set(room.id, new Set());
  const bans = bannedPlayers.get(room.id);
  bans.add(`name:${target.name.toLowerCase()}`);
  if (target.sessionToken) bans.add(`token:${target.sessionToken}`);
  emitLog(room, `${target.name} fue baneado.`, 'ban');
  io.to(targetId).emit('banned', { reason: 'Fuiste baneado de esta sala.' });
  removePlayerFromRoom(room, targetId, false);
  return true;
}

function addChips(room, hostSocketId, targetId, amount) {
  if (!assertHost(room, hostSocketId)) return false;
  const amt = validateNumber(amount, 1, 1000000);
  if (amt === null) return false;
  const target = room.players.find(p => p.id === targetId && !p.left);
  if (!target) return false;
  const phase = room.gameState?.phase;
  if (room.state === 'playing' && phase && phase !== 'waiting' && phase !== 'showdown') {
    return rejectAction(room, hostSocketId, 'No se pueden agregar fichas durante una mano activa.');
  }
  target.stack += amt;
  if (target.eliminated && target.stack > 0) {
    target.eliminated = false; target.allIn = false;
    target.status = 'revivedNextHand'; target.waitingNextHand = true;
    io.to(targetId).emit('revived', { stack: target.stack });
  }
  cancelRoomClose(room);
  emitLog(room, `${amt} fichas dadas a ${target.name}.`, 'chips');
  emitRoomState(room);
  if (room.gameState && ['waiting','showdown'].includes(room.gameState.phase)) {
    const contenders = room.players.filter(p => !p.eliminated && !p.left && !p.disconnected && p.stack > 0);
    if (contenders.length >= MIN_PLAYERS) scheduleNextHand(room, SHOWDOWN_DELAY);
  }
  return true;
}

function restartGame(room, hostSocketId) {
  if (!assertHost(room, hostSocketId)) return false;
  clearTurnTimer(room);
  cancelRoomClose(room);
  if (room.gameState?.nextHandTimer) clearTimeout(room.gameState.nextHandTimer);
  room.players = room.players.filter(p => !p.left && !p.pendingRemoval);
  room.players.forEach((p,i) => {
    p.seatIndex = i;
    p.stack = room.startingStack; p.eliminated = false; p.status = 'active';
    p.folded = false; p.allIn = false;
    p.bet = 0; p.totalBet = 0; p.cards = [];
    p.waitingNextHand = false; p.hasExchanged = false; p.cardsSelected = [];
    p.status = p.disconnected ? 'disconnected' : 'active';
    p.actedThisRound = false; p.lastActionBet = 0;
  });
  room.gameState = null;
  room.state = 'waiting'; room.hasStarted = false; room.paused = false;
  emitLog(room, 'El anfitrión reinició la partida.', 'info');
  emitRoomState(room); broadcastRoomList();
  return true;
}

function endGame(room, hostSocketId) {
  if (!assertHost(room, hostSocketId)) return false;
  clearTurnTimer(room);
  emitLog(room, 'El anfitrión terminó la partida.', 'info');
  return closeRoom(room, 'El anfitrión cerró la sala.');
}

function updateSettings(room, hostSocketId, settings) {
  if (!assertHost(room, hostSocketId)) return false;
  const s = room.settings;
  if (typeof settings.allowRevive === 'boolean') s.allowRevive = settings.allowRevive;
  if (typeof settings.requireReviveVote === 'boolean') s.requireReviveVote = settings.requireReviveVote;
  if (typeof settings.allowSpectators === 'boolean') s.allowSpectators = settings.allowSpectators;
  if (typeof settings.closeOnHostLeave === 'boolean') s.closeOnHostLeave = settings.closeOnHostLeave;
  if (typeof settings.showRivalStacksOnTable === 'boolean') s.showRivalStacksOnTable = settings.showRivalStacksOnTable;
  if (typeof settings.compactMode === 'boolean') s.compactMode = settings.compactMode;
  if (typeof settings.reducedAnimations === 'boolean') s.reducedAnimations = settings.reducedAnimations;
  if (typeof settings.audioEnabled === 'boolean') s.audioEnabled = settings.audioEnabled;
  if (['full','alerts','disabled'].includes(settings.chatMode)) s.chatMode = settings.chatMode;
  const turnTO = validateNumber(settings.turnTimeout, 10000, 300000);
  if (turnTO !== null) s.turnTimeout = turnTO;
  if (room.state !== 'playing') {
    const proposedSB = validateNumber(settings.smallBlind, 1, 10000);
    const proposedBB = validateNumber(settings.bigBlind, 2, 20000);
    const nextSB = proposedSB ?? s.smallBlind;
    const nextBB = proposedBB ?? s.bigBlind;
    if (nextSB < nextBB) { s.smallBlind = nextSB; s.bigBlind = nextBB; }
    else if (proposedSB !== null || proposedBB !== null) rejectAction(room, hostSocketId, 'La Big Blind debe ser mayor que la Small Blind.');
  }
  const revStack = validateNumber(settings.reviveStack, 100, 100000);
  if (revStack !== null) s.reviveStack = revStack;
  const maxCC = validateNumber(settings.maxCardsChange, 0, 5);
  if (maxCC !== null && room.state !== 'playing') s.maxCardsChange = maxCC;
  emitLog(room, 'Configuración actualizada.', 'info');
  emitRoomState(room);
  return true;
}

// ============================================================
// PLAYER MANAGEMENT
// ============================================================
function removePlayerFromRoom(room, socketId, disconnect=false) {
  const playerIdx = room.players.findIndex(p => p.id === socketId);
  const spectatorIdx = room.spectators.findIndex(s => s.id === socketId);
  let playerName = 'Jugador';

  if (playerIdx !== -1) {
    const player = room.players[playerIdx];
    playerName = player.name;
    if (player._removalTimer) { clearTimeout(player._removalTimer); player._removalTimer = null; }

    const activeHand = room.hasStarted && room.gameState && !['waiting','showdown'].includes(room.gameState.phase);
    if (disconnect || activeHand) {
      player.disconnected = true;
      player.status = 'disconnected';
      if (!player.allIn) player.folded = true; // committed all-in hands remain live through showdown
      emitLog(room, `${player.name} ${disconnect ? 'se desconectó' : 'abandonó la mesa'}.`, disconnect ? 'disconnect' : 'leave');

      if (activeHand) {
        const gs = room.gameState;
        if (gs.phase === 'exchange') {
          const exIdx = gs.exchangeOrder[gs.exchangeIndex];
          if (exIdx === playerIdx && !player.hasExchanged) {
            clearTurnTimer(room);
            player.hasExchanged = true; gs.exchangeIndex++; proceedExchange(room);
          } else {
            emitRoomState(room);
          }
        } else if (gs.currentPlayerIndex === playerIdx) {
          // Only a disconnect of the CURRENT actor may move the turn.
          clearTurnTimer(room);
          resumeBettingOrAdvance(room, playerIdx);
        } else {
          // A non-current disconnect must never steal/reset another player's timer or skip their action.
          emitRoomState(room);
        }
      }

      if (disconnect) {
        player._removalTimer = setTimeout(() => {
          if (!rooms.has(room.id) || !player.disconnected) return;
          player.pendingRemoval = true;
          const handStillActive = room.gameState && !['waiting','showdown'].includes(room.gameState.phase);
          if (!(handStillActive && player.allIn && !player.folded)) {
            player.left = true;
            player.status = 'left';
            player.eliminated = true;
          }
          socketToRoom.delete(socketId); socketToPlayer.delete(socketId);
          checkRoomEmpty(room);
          if (rooms.has(room.id)) {
            emitRoomState(room); broadcastRoomList();
            if (room.hasStarted && room.gameState && ['waiting','showdown'].includes(room.gameState.phase)) {
              scheduleNextHand(room, 150);
            }
          }
        }, RECONNECT_TIMEOUT);
      } else {
        player.pendingRemoval = true;
        if (!(activeHand && player.allIn && !player.folded)) {
          player.left = true; player.status = 'left'; player.eliminated = true;
        }
        socketToRoom.delete(socketId); socketToPlayer.delete(socketId);
      }
    } else {
      // Safe to compact the array before a game has started.
      room.players.splice(playerIdx, 1);
      room.players.forEach((p,i) => p.seatIndex = i);
      socketToRoom.delete(socketId); socketToPlayer.delete(socketId);
    }
  } else if (spectatorIdx !== -1) {
    playerName = room.spectators[spectatorIdx].name;
    room.spectators.splice(spectatorIdx, 1);
    socketToRoom.delete(socketId);
  }

  if (room.hostSocketId === socketId) {
    const newHost = room.players.find(p => !p.disconnected && !p.left && !p.eliminated && p.stack > 0) || room.players.find(p => !p.disconnected && !p.left);
    if (newHost && !room.settings.closeOnHostLeave) {
      room.hostSocketId = newHost.id;
      emitLog(room, `${playerName} (anfitrión) se fue. Nuevo anfitrión: ${newHost.name}.`, 'info');
      io.to(newHost.id).emit('becameHost');
    } else {
      checkRoomEmpty(room);
      if (rooms.has(room.id)) closeRoom(room, `El anfitrión ${playerName} se fue. La sala fue cerrada.`);
      return;
    }
  }

  checkRoomEmpty(room);
  if (!rooms.has(room.id)) return;
  if (room.hasStarted) {
    const activeLeft = room.players.filter(p => !p.eliminated && !p.left && p.stack > 0);
    const bustedWithRevive = room.players.filter(p => p.eliminated && !p.disconnected && !p.left && room.settings.allowRevive);
    if (activeLeft.length < MIN_PLAYERS && bustedWithRevive.length === 0 && room.gameState?.phase === 'showdown') {
      const msg = activeLeft[0] ? `${activeLeft[0].name} gana. La sala se cerró.` : 'La partida terminó.';
      scheduleRoomClose(room, msg, 1500);
      return;
    }
  }
  emitRoomState(room);
  broadcastRoomList();
}

function advanceTurnAfterFold(room) {
  const gs = room.gameState;
  if (!gs) return;
  resumeBettingOrAdvance(room, gs.currentPlayerIndex);
}

function checkRoomEmpty(room) {
  const connected = room.players.filter(p => !p.disconnected && !p.left).length + room.spectators.length;
  if (connected === 0) {
    clearTurnTimer(room);
    for (const p of room.players) if (p._removalTimer) clearTimeout(p._removalTimer);
    if (bannedPlayers.has(room.id)) bannedPlayers.delete(room.id);
    rooms.delete(room.id);
    broadcastRoomList();
  }
}

// ============================================================
// SOCKET HANDLERS
// ============================================================
io.on('connection', (socket) => {
  socket.emit('roomList', getRoomList());

  socket.on('createRoom', (data) => {
    try {
      if (socketToRoom.has(socket.id)) return socket.emit('error', { msg: 'Ya estás en una sala.' });
      if (!data || typeof data !== 'object') return socket.emit('error', { msg: 'Datos inválidos.' });
      const name = sanitize(data.roomName) || 'Sala de Poker';
      const playerName = sanitize(data.playerName) || 'Host';
      const password = typeof data.password === 'string' ? data.password.slice(0,20) : '';
      const maxPlayers = validateNumber(data.maxPlayers, MIN_PLAYERS, MAX_PLAYERS) || 6;
      const startingStack = validateNumber(data.startingStack, 100, 1000000) || DEFAULT_STACK;
      const gameMode = data.gameMode === 'classic' ? 'classic' : 'texas';
      const sessionToken = sanitizeSessionToken(data.sessionToken);

      const roomId = crypto.randomBytes(4).toString('hex');
      const room = createRoom(roomId, name, socket.id, playerName, password, maxPlayers, startingStack, gameMode);
      if (data.settings && typeof data.settings === 'object') {
        updateSettings(room, socket.id, data.settings);
      }
      const player = createPlayer(socket.id, playerName, room.startingStack, data.profile, sessionToken);
      player.seatIndex = 0;
      room.players.push(player);
      rooms.set(roomId, room);
      socketToRoom.set(socket.id, roomId);
      socketToPlayer.set(socket.id, player);
      socket.join(roomId);
      socket.emit('roomJoined', { roomId, isHost: true, gameMode });
      emitRoomState(room);
      broadcastRoomList();
      emitLog(room, `${playerName} creó la sala. Modo: ${gameMode === 'classic' ? 'Póker Clásico' : 'Texas Hold\'em'}`, 'info');
    } catch(e) { socket.emit('error', { msg: 'Error al crear sala.' }); }
  });

  socket.on('joinRoom', (data) => {
    try {
      if (socketToRoom.has(socket.id)) return socket.emit('error', { msg: 'Ya estás en una sala.' });
      if (!data || typeof data !== 'object') return socket.emit('error', { msg: 'Datos inválidos.' });
      const room = rooms.get(data.roomId);
      if (!room) return socket.emit('error', { msg: 'Sala no encontrada.' });
      const playerName = sanitize(data.playerName) || 'Player';
      const sessionToken = sanitizeSessionToken(data.sessionToken);

      if (bannedPlayers.has(room.id)) {
        const bans = bannedPlayers.get(room.id);
        if (bans.has(`name:${playerName.toLowerCase()}`) || (sessionToken && bans.has(`token:${sessionToken}`))) {
          return socket.emit('banned', { reason: 'Estás baneado de esta sala.' });
        }
      }
      if (room.password && room.password !== data.password) {
        return socket.emit('error', { msg: 'Contraseña incorrecta.' });
      }

      // Session tokens are per browser tab and may only belong to one connected seat in a room.
      if (sessionToken && room.players.some(p => p.sessionToken === sessionToken && !p.disconnected && !p.left)) {
        return socket.emit('error', { msg: 'Esta sesión ya está conectada en otra pestaña.' });
      }

      // Try reconnect
      const disconnectedPlayer = room.players.find(p => p.sessionToken && sessionToken && p.sessionToken === sessionToken && p.disconnected && !p.left && !p.pendingRemoval);
      if (disconnectedPlayer) {
        const oldId = disconnectedPlayer.id;
        if (disconnectedPlayer._removalTimer) {
          clearTimeout(disconnectedPlayer._removalTimer);
          disconnectedPlayer._removalTimer = null;
        }
        disconnectedPlayer.id = socket.id;
        disconnectedPlayer.disconnected = false;
        disconnectedPlayer.pendingRemoval = false;
        cancelRoomClose(room);
        const safeProfile = sanitizeProfile(data.profile);
        disconnectedPlayer.avatarId = safeProfile.avatarId;
        disconnectedPlayer.emotes = safeProfile.emotes;
        if (room.hostSocketId === oldId) room.hostSocketId = socket.id;
        socketToRoom.delete(oldId);
        socketToPlayer.delete(oldId);
        socketToRoom.set(socket.id, room.id);
        socketToPlayer.set(socket.id, disconnectedPlayer);
        socket.join(room.id);
        const isHost = room.hostSocketId === socket.id;
        socket.emit('roomJoined', { roomId: room.id, isHost, gameMode: room.gameMode });
        if (isHost) socket.emit('becameHost');
        emitLog(room, `${playerName} reconectado.`, 'info');
        emitRoomState(room);
        if (room.hasStarted && room.gameState && ['waiting','showdown'].includes(room.gameState.phase)) scheduleNextHand(room, 250);
        return;
      }

      if (room.players.some(p => !p.left && !p.disconnected && p.name.toLowerCase() === playerName.toLowerCase())) {
        return socket.emit('error', { msg: 'Ya hay un jugador conectado con ese nombre.' });
      }

      // Spectator check
      const seatedCount = room.players.filter(p=>!p.disconnected && !p.eliminated && p.stack > 0).length;
      if (seatedCount >= room.maxPlayers || room.state === 'playing') {
        if (!room.settings.allowSpectators) {
          return socket.emit('error', { msg: 'Sala llena.' });
        }
        { const safeProfile = sanitizeProfile(data.profile); room.spectators.push({ id: socket.id, name: playerName, avatarId: safeProfile.avatarId, emotes: safeProfile.emotes, lastChat: 0 }); }
        socketToRoom.set(socket.id, room.id);
        socket.join(room.id);
        socket.emit('roomJoined', { roomId: room.id, isHost: false, isSpectator: true, gameMode: room.gameMode });
        emitLog(room, `${playerName} se unió como espectador.`, 'info');
        emitRoomState(room);
        broadcastRoomList();
        return;
      }

      if (room.players.length >= room.maxPlayers) {
        return socket.emit('error', { msg: 'Sala llena.' });
      }

      const player = createPlayer(socket.id, playerName, room.startingStack, data.profile, sessionToken);
      player.seatIndex = room.players.length;
      if (room.state === 'playing') { player.waitingNextHand = true; player.folded = true; }
      room.players.push(player);
      socketToRoom.set(socket.id, room.id);
      socketToPlayer.set(socket.id, player);
      socket.join(room.id);
      socket.emit('roomJoined', { roomId: room.id, isHost: false, gameMode: room.gameMode });
      emitLog(room, room.state === 'playing'
        ? `${playerName} se unió y jugará desde la próxima mano.`
        : `${playerName} se unió a la sala.`, 'join');
      emitRoomState(room);
      broadcastRoomList();
    } catch(e) { socket.emit('error', { msg: 'Error al unirse.' }); }
  });

  socket.on('startGame', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return socket.emit('error', { msg: 'Solo el anfitrión puede iniciar.' });
    if (room.state === 'playing') return socket.emit('error', { msg: 'Partida ya en curso.' });
    startGame(room);
  });

  socket.on('action', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room || room.state !== 'playing') return;
    if (room.paused) return socket.emit('error', { msg: 'La partida está pausada.' });
    if (!data || typeof data !== 'object') return;
    const action = data.action;
    const amount = parseInt(data.amount) || 0;
    if (!['fold','check','call','raise','allin'].includes(action)) return;
    handleAction(room, socket.id, action, amount);
  });

  socket.on('exchangeCards', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room || room.state !== 'playing') return;
    if (room.paused) return socket.emit('error', { msg: 'La partida está pausada.' });
    const indices = Array.isArray(data?.indices) ? data.indices : [];
    handleExchangeAction(room, socket.id, 'exchange', indices);
  });


  socket.on('emote', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    const entity = room.players.find(p=>p.id===socket.id) || room.spectators.find(s=>s.id===socket.id);
    if (!entity) return;
    const emoteId = String(data?.emoteId || '').toLowerCase().slice(0, 20);
    const equipped = Array.isArray(entity.emotes) ? entity.emotes : [];
    if (!ALLOWED_EMOTES.has(emoteId) || (equipped.length && !equipped.includes(emoteId))) return;
    const label = ALLOWED_EMOTES.get(emoteId);
    io.to(room.id).emit('emote', { system: true, type: 'emote', playerId: socket.id, name: entity.name, emoteId, text: label, ts: Date.now() });
  });

  socket.on('togglePause', () => {
    const room = getPlayerRoom(socket.id);
    if (!room || room.hostSocketId !== socket.id) return;
    room.paused = !room.paused;
    clearTurnTimer(room);
    emitLog(room, room.paused ? 'Partida pausada por el anfitrión.' : 'Partida reanudada por el anfitrión.', 'warning');
    emitRoomState(room);
    if (!room.paused && room.gameState && !['waiting','showdown'].includes(room.gameState.phase)) {
      if (room.gameState.phase === 'exchange') proceedExchange(room);
      else resumeBettingOrAdvance(room, (room.gameState.currentPlayerIndex - 1 + room.players.length) % room.players.length);
    }
  });

  socket.on('chatMessage', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    if (room.settings.chatMode === 'disabled' || room.settings.chatMode === 'alerts') {
      return socket.emit('error', { msg: 'El chat está desactivado en esta sala.' });
    }
    const text = sanitizeMsg(typeof data?.text === 'string' ? data.text : '');
    if (!text) return;
    const entity = room.players.find(p=>p.id===socket.id) || room.spectators.find(s=>s.id===socket.id);
    if (!entity) return;
    const now = Date.now();
    if (now - (entity.lastChat || 0) < CHAT_COOLDOWN) return;
    entity.lastChat = now;
    io.to(room.id).emit('chatMessage', { name: entity.name, text, ts: now });
  });

  socket.on('requestRevive', () => {
    const room = getPlayerRoom(socket.id);
    if (room) requestRevive(room, socket.id);
  });

  socket.on('voteRevive', (data) => {
    const room = getPlayerRoom(socket.id);
    if (room) voteRevive(room, socket.id, !!data?.vote);
  });

  socket.on('kickPlayer', (data) => {
    const room = getPlayerRoom(socket.id);
    if (room && data?.targetId) kickPlayer(room, socket.id, data.targetId);
  });

  socket.on('banPlayer', (data) => {
    const room = getPlayerRoom(socket.id);
    if (room && data?.targetId) banPlayer(room, socket.id, data.targetId);
  });

  socket.on('addChips', (data) => {
    const room = getPlayerRoom(socket.id);
    if (room && data) addChips(room, socket.id, data.targetId, data.amount);
  });

  socket.on('restartGame', () => {
    const room = getPlayerRoom(socket.id);
    if (room) restartGame(room, socket.id);
  });

  socket.on('endGame', () => {
    const room = getPlayerRoom(socket.id);
    if (room) endGame(room, socket.id);
  });

  socket.on('updateSettings', (data) => {
    const room = getPlayerRoom(socket.id);
    if (room && data && typeof data === 'object') updateSettings(room, socket.id, data);
  });

  socket.on('leaveRoom', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    emitLog(room, `${getPlayerName(socket.id, room)} abandonó la sala.`, 'leave');
    removePlayerFromRoom(room, socket.id, false);
    socket.leave(room.id);
  });

  socket.on('disconnect', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) {
      socketToRoom.delete(socket.id);
      socketToPlayer.delete(socket.id);
      return;
    }
    removePlayerFromRoom(room, socket.id, true);
  });

  socket.on('getRooms', () => {
    socket.emit('roomList', getRoomList());
  });
});

function getPlayerRoom(socketId) {
  const roomId = socketToRoom.get(socketId);
  return roomId ? (rooms.get(roomId) || null) : null;
}

function getPlayerName(socketId, room) {
  const p = room.players.find(p=>p.id===socketId) || room.spectators.find(s=>s.id===socketId);
  return p ? p.name : 'Jugador';
}

// ============================================================
// SERVER START
// ============================================================
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Royal Poker V6.1 server running on port ${PORT}`);
  });
}

module.exports = {
  createDeck, evaluateHand, bestHand, bestHandExact, compareScores,
  createRoom, createPlayer, createGameState, startGame, startNewHand,
  handleAction, handleExchangeAction, calculateSidePots,
  getActivePlayers, canPlayerRaise, bettingRoundComplete, advancePhase, buildGameStateFor,
  removePlayerFromRoom, resumeBettingOrAdvance, startTurnTimer, clearTurnTimer,
  rooms, io, server
};