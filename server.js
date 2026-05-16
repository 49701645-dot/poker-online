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
const ACTION_COOLDOWN = 500;
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

function cardRank(c) { return RANK_VAL[c[0]]; }
function cardSuit(c) { return c[1]; }

function bestHand(cards) {
  if (cards.length < 5) return null;
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluateHand(combo);
    if (!best || compareScores(score, best.score) > 0) {
      best = { cards: combo, score };
    }
  }
  return best;
}

function bestHandExact(cards) {
  if (!cards || cards.length !== 5) return null;
  const score = evaluateHand(cards);
  return { cards, score };
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
      audioEnabled: false
    }
  };
}

function createPlayer(socketId, name, stack) {
  return {
    id: socketId,
    name: sanitize(name),
    stack, bet: 0, totalBet: 0,
    cards: [],
    folded: false, allIn: false,
    disconnected: false, eliminated: false, status: 'active',
    seatIndex: -1,
    lastAction: 0, lastChat: 0,
    waitingNextHand: false,
    cardsSelected: [], hasExchanged: false,
    _removalTimer: null
  };
}

function sanitize(str) {
  if (typeof str !== 'string') return 'Player';
  return str.replace(/[<>&"'`]/g, '').trim().slice(0, MAX_NAME_LEN) || 'Player';
}

function sanitizeMsg(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/</g,'&lt;').replace(/>/g,'&gt;').trim().slice(0, MAX_MSG_LEN);
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
    communityCards: [],
    pot: 0, sidePots: [],
    currentPlayerIndex: -1,
    dealerIndex: 0,
    smallBlindIndex: 1, bigBlindIndex: 2,
    phase: 'waiting',
    smallBlind: sb, bigBlind: bb,
    currentBet: 0, minRaise: bb,
    lastRaiseIndex: -1, actionCount: 0,
    turnTimer: null, handNumber: 0,
    reviveRequest: null,
    exchangeOrder: [], exchangeIndex: 0
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
      cards = p.cards;
    } else if (isMe) {
      cards = p.cards;
    } else {
      cards = p.cards.map(() => 'back');
    }

    let status = p.status || 'active';
    if (p.disconnected) status = 'disconnected';
    else if (p.eliminated || p.stack <= 0) status = (p.status === 'revivedNextHand') ? 'revivedNextHand' : 'busted';
    else if (p.allIn) status = 'allin';
    else if (p.folded && !p.waitingNextHand) status = 'folded';
    else if (p.waitingNextHand) status = 'waiting';

    return {
      id: p.id, name: p.name,
      stack: p.stack, bet: p.bet, totalBet: p.totalBet,
      cards,
      folded: p.folded, allIn: p.allIn,
      disconnected: p.disconnected, eliminated: p.eliminated,
      seatIndex: p.seatIndex,
      isHost: p.id === room.hostSocketId,
      waitingNextHand: !!p.waitingNextHand,
      status,
      cardsSelected: isMe && gs && gs.phase === 'exchange' ? (p.cardsSelected || []) : [],
      hasExchanged: !!p.hasExchanged
    };
  });

  const gsData = gs ? {
    communityCards: gs.communityCards,
    pot: gs.pot, sidePots: gs.sidePots,
    currentPlayerIndex: gs.currentPlayerIndex,
    dealerIndex: gs.dealerIndex,
    smallBlindIndex: gs.smallBlindIndex,
    bigBlindIndex: gs.bigBlindIndex,
    phase: gs.phase,
    smallBlind: gs.smallBlind, bigBlind: gs.bigBlind,
    currentBet: gs.currentBet, minRaise: gs.minRaise,
    handNumber: gs.handNumber,
    reviveRequest: gs.reviveRequest,
    exchangePlayerIndex: gs.phase === 'exchange' ? gs.exchangeOrder[gs.exchangeIndex] : null
  } : null;

  return {
    roomId: room.id, roomName: room.name,
    hostId: room.hostSocketId,
    state: room.state,
    gameMode: room.gameMode || 'texas',
    settings: room.settings,
    players,
    spectators: room.spectators.map(s=>({id:s.id,name:s.name})),
    myId: socketId, isSpectator,
    gameState: gsData
  };
}

function emitLog(room, msg, type='info') {
  io.to(room.id).emit('chatMessage', { system: true, text: msg, type, ts: Date.now() });
}

// ============================================================
// ROOM CLOSE
// ============================================================
function closeRoom(room, reason='La sala fue cerrada.') {
  if (!room || !rooms.has(room.id)) return false;
  clearTurnTimer(room);
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
  const activePlayers = room.players.filter(p => !p.eliminated && !p.disconnected && p.stack > 0);
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

  emitLog(room, `🃏 ¡Partida iniciada! Modo: ${room.gameMode === 'classic' ? 'Póker Clásico (5 cartas)' : 'Texas Hold\'em'}`, 'success');
  startNewHand(room);
  broadcastRoomList();
}

function startNewHand(room) {
  const gs = room.gameState;
  for (const p of room.players) {
    if (p.stack > 0 && !p.eliminated) p.waitingNextHand = false;
    p.hasExchanged = false;
    p.cardsSelected = [];
  }
  gs.handNumber++;

  gs.deck = shuffle(createDeck());
  gs.communityCards = [];
  gs.pot = 0; gs.sidePots = [];
  gs.currentBet = 0; gs.minRaise = gs.bigBlind;
  gs.actionCount = 0;
  gs.reviveRequest = null;
  gs.exchangeOrder = []; gs.exchangeIndex = 0;

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.waitingNextHand && p.stack > 0);
  if (active.length < MIN_PLAYERS) {
    if (room.hasStarted) {
      const busted = room.players.filter(p => p.eliminated && !p.disconnected && room.settings.allowRevive);
      if (busted.length > 0 && active.length >= 1) {
        emitLog(room, `⏸️ Esperando posibles solicitudes de revive...`, 'warning');
        gs.phase = 'showdown';
        emitRoomState(room);
        return;
      }
      const winner = active[0]?.name;
      const msg = winner ? `🏆 ${winner} gana la partida. La sala se cerrará.` : 'La partida terminó. La sala se cerrará.';
      emitLog(room, msg, 'champion');
      setTimeout(() => { if (rooms.has(room.id)) closeRoom(room, msg); }, 1500);
    } else {
      room.state = 'waiting';
      emitLog(room, '⏸️ Esperando jugadores...', 'warning');
      emitRoomState(room);
      broadcastRoomList();
    }
    return;
  }

  for (const p of room.players) {
    p.folded = p.eliminated || p.disconnected || p.waitingNextHand || p.stack <= 0;
    p.status = p.disconnected ? 'disconnected' : (p.eliminated || p.stack <= 0 ? 'busted' : (p.waitingNextHand ? 'waiting' : 'active'));
    p.allIn = false; p.bet = 0; p.totalBet = 0; p.cards = [];
  }

  // Advance dealer
  const nextDealer = getNextActiveIndex(room, gs.dealerIndex);
  gs.dealerIndex = nextDealer;

  const activePl = room.players.filter(p=>!p.folded);
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
  gs.currentBet = gs.bigBlind;
  gs.minRaise = gs.bigBlind;

  // Deal
  if (room.gameMode === 'classic') {
    for (let i = 0; i < 5; i++) {
      for (const p of room.players) {
        if (!p.folded) p.cards.push(gs.deck.pop());
      }
    }
  } else {
    for (let i = 0; i < 2; i++) {
      for (const p of room.players) {
        if (!p.folded) p.cards.push(gs.deck.pop());
      }
    }
  }

  gs.phase = 'preflop';
  gs.lastRaiseIndex = bbIdx;
  const utg = nActive === 2 ? sbIdx : getNextActiveIndex(room, bbIdx);
  gs.currentPlayerIndex = utg;

  emitLog(room, `🃏 Mano #${gs.handNumber} | Dealer: ${room.players[gs.dealerIndex]?.name} | SB: ${sbPlayer?.name} (${gs.smallBlind}) | BB: ${bbPlayer?.name} (${gs.bigBlind})`, 'info');
  emitRoomState(room);
  startTurnTimer(room);
}

function postBlind(player, gs, amount) {
  if (!player) return;
  const actual = Math.min(amount, player.stack);
  player.bet += actual; player.totalBet += actual;
  player.stack -= actual; gs.pot += actual;
  if (player.stack === 0) player.allIn = true;
}

function getNextActiveIndex(room, fromIndex) {
  const n = room.players.length;
  if (n === 0) return 0;
  let idx = ((fromIndex + 1) % n + n) % n;
  for (let count = 0; count < n; count++) {
    const p = room.players[idx];
    if (p && !p.folded && !p.eliminated && !p.disconnected) return idx;
    idx = (idx + 1) % n;
  }
  return ((fromIndex + 1) % n + n) % n;
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.folded && !p.eliminated && !p.disconnected && !p.waitingNextHand);
}

function startTurnTimer(room) {
  const gs = room.gameState;
  if (!gs) return;
  if (gs.turnTimer) clearTimeout(gs.turnTimer);

  const currentPlayer = room.players[gs.currentPlayerIndex];
  if (!currentPlayer) return;

  const timeout = room.settings.turnTimeout || TURN_TIMEOUT;
  io.to(room.id).emit('turnStart', { playerId: currentPlayer.id, timeout, ts: Date.now() });

  gs.turnTimer = setTimeout(() => {
    if (!rooms.has(room.id)) return;
    const gs2 = room.gameState;
    if (!gs2) return;

    if (gs2.phase === 'exchange') {
      const exIdx = gs2.exchangeOrder[gs2.exchangeIndex];
      const p = room.players[exIdx];
      if (p && !p.hasExchanged) {
        emitLog(room, `⏱️ ${p.name} no cambió cartas (tiempo agotado).`, 'warning');
        handleExchangeAction(room, p.id, 'exchange', []);
      }
      return;
    }

    const curIdx = gs2.currentPlayerIndex;
    const p = room.players[curIdx];
    if (p && !p.folded && !p.eliminated && !p.disconnected) {
      emitLog(room, `⏱️ ${p.name} agotó su tiempo. Fold automático.`, 'warning');
      handleAction(room, p.id, 'fold', 0);
    }
  }, timeout);
}

function clearTurnTimer(room) {
  if (room.gameState && room.gameState.turnTimer) {
    clearTimeout(room.gameState.turnTimer);
    room.gameState.turnTimer = null;
  }
}

function handleAction(room, socketId, action, amount) {
  const gs = room.gameState;
  if (!gs) return false;
  if (gs.phase === 'exchange') return handleExchangeAction(room, socketId, 'exchange', []);
  if (gs.phase === 'waiting' || gs.phase === 'showdown') return false;

  const curIdx = gs.currentPlayerIndex;
  const player = room.players[curIdx];
  if (!player || player.id !== socketId) return false;
  if (player.folded || player.allIn || player.disconnected || player.eliminated) return false;

  const now = Date.now();
  if (now - player.lastAction < ACTION_COOLDOWN) return false;
  player.lastAction = now;

  clearTurnTimer(room);

  const callAmount = gs.currentBet - player.bet;
  let valid = false;

  switch (action) {
    case 'fold':
      player.folded = true;
      emitLog(room, `🃏 ${player.name} se fue al fold.`, 'fold');
      valid = true;
      break;

    case 'check':
      if (callAmount !== 0) return false;
      emitLog(room, `✅ ${player.name} checkeó.`, 'check');
      valid = true;
      break;

    case 'call': {
      if (callAmount <= 0) return false;
      const actual = Math.min(callAmount, player.stack);
      player.bet += actual; player.totalBet += actual;
      player.stack -= actual; gs.pot += actual;
      if (player.stack === 0) {
        player.allIn = true;
        emitLog(room, `💥 ${player.name} va ALL-IN con ${player.totalBet}!`, 'allin');
      } else {
        emitLog(room, `📞 ${player.name} llamó ${actual}.`, 'call');
      }
      valid = true;
      break;
    }

    case 'raise': {
      const raiseAmount = validateNumber(amount, 1, 99999999);
      if (raiseAmount === null) return false;
      const totalNeeded = gs.currentBet + Math.max(raiseAmount, gs.minRaise);
      const raiseTotal = totalNeeded - player.bet;
      if (raiseTotal <= 0 || raiseTotal > player.stack) return false;

      gs.minRaise = raiseAmount;
      player.bet += raiseTotal; player.totalBet += raiseTotal;
      player.stack -= raiseTotal; gs.pot += raiseTotal;
      gs.currentBet = player.bet;
      gs.lastRaiseIndex = curIdx;
      gs.actionCount = 0;

      if (player.stack === 0) {
        player.allIn = true;
        emitLog(room, `💥 ${player.name} va ALL-IN con ${player.totalBet}!`, 'allin');
      } else {
        emitLog(room, `⬆️ ${player.name} subió a ${gs.currentBet}.`, 'raise');
      }
      valid = true;
      break;
    }

    case 'allin': {
      const allInAmount = player.stack;
      if (allInAmount <= 0) return false;
      if (player.bet + allInAmount > gs.currentBet) {
        gs.minRaise = Math.max(gs.minRaise, player.bet + allInAmount - gs.currentBet);
        gs.currentBet = player.bet + allInAmount;
        gs.lastRaiseIndex = curIdx;
        gs.actionCount = 0;
      }
      player.bet += allInAmount; player.totalBet += allInAmount;
      gs.pot += allInAmount; player.stack = 0; player.allIn = true;
      emitLog(room, `💥 ${player.name} va ALL-IN con ${player.totalBet}!`, 'allin');
      valid = true;
      break;
    }
  }

  if (!valid) return false;
  gs.actionCount++;

  const active = getActivePlayers(room);
  if (active.length <= 1) { endHand(room); return true; }

  const bettingPlayers = active.filter(p => !p.allIn);
  const allEven = bettingPlayers.every(p => p.bet === gs.currentBet);

  if (bettingPlayers.length === 0 || (allEven && gs.actionCount >= bettingPlayers.length && curIdx !== gs.lastRaiseIndex)) {
    advancePhase(room);
    return true;
  }

  let nextIdx = getNextActiveIndex(room, curIdx);
  let tries = 0;
  while (room.players[nextIdx]?.allIn && tries < room.players.length) {
    nextIdx = getNextActiveIndex(room, nextIdx);
    tries++;
  }

  if (nextIdx === gs.lastRaiseIndex) { advancePhase(room); return true; }
  if (allEven && nextIdx === gs.bigBlindIndex && gs.phase === 'preflop' && gs.actionCount >= active.length) {
    advancePhase(room); return true;
  }

  const stillUneven = getActivePlayers(room).filter(p=>!p.allIn).some(p=>p.bet < gs.currentBet);
  if (!stillUneven && !room.players[nextIdx]?.allIn && nextIdx === gs.lastRaiseIndex) {
    advancePhase(room); return true;
  }

  gs.currentPlayerIndex = nextIdx;
  emitRoomState(room);
  startTurnTimer(room);
  return true;
}

function advancePhase(room) {
  const gs = room.gameState;
  clearTurnTimer(room);

  for (const p of room.players) p.bet = 0;
  gs.actionCount = 0;
  gs.currentBet = 0;
  gs.minRaise = gs.bigBlind;
  gs.lastRaiseIndex = -1;

  if (room.gameMode === 'classic') {
    if (gs.phase === 'preflop') { startExchangePhase(room); return; }
    if (gs.phase === 'postexchange') { endHand(room); return; }
    return;
  }

  // Texas
  switch (gs.phase) {
    case 'preflop':
      gs.phase = 'flop';
      gs.communityCards.push(gs.deck.pop(), gs.deck.pop(), gs.deck.pop());
      emitLog(room, `🃏 FLOP: ${gs.communityCards.join(' ')}`, 'phase');
      break;
    case 'flop':
      gs.phase = 'turn';
      gs.communityCards.push(gs.deck.pop());
      emitLog(room, `🃏 TURN: ${gs.communityCards[3]}`, 'phase');
      break;
    case 'turn':
      gs.phase = 'river';
      gs.communityCards.push(gs.deck.pop());
      emitLog(room, `🃏 RIVER: ${gs.communityCards[4]}`, 'phase');
      break;
    case 'river':
      endHand(room); return;
  }

  const firstActor = getNextActiveIndex(room, gs.dealerIndex);
  gs.currentPlayerIndex = firstActor;

  const notAllIn = getActivePlayers(room).filter(p=>!p.allIn);
  if (notAllIn.length === 0) {
    emitRoomState(room);
    setTimeout(() => { if (rooms.has(room.id)) advancePhase(room); }, 1500);
    return;
  }

  if (room.players[gs.currentPlayerIndex]?.allIn) {
    gs.currentPlayerIndex = getNextActiveIndex(room, gs.currentPlayerIndex);
  }

  emitRoomState(room);
  startTurnTimer(room);
}

// ============================================================
// CLASSIC MODE — EXCHANGE PHASE
// ============================================================
function startExchangePhase(room) {
  const gs = room.gameState;
  gs.phase = 'exchange';

  const activePl = room.players.filter(p => !p.folded && !p.eliminated && !p.disconnected);
  let start = getNextActiveIndex(room, gs.dealerIndex);
  const ordered = [];
  for (let i = 0; i < activePl.length; i++) {
    ordered.push(start);
    start = getNextActiveIndex(room, start);
  }
  gs.exchangeOrder = ordered;
  gs.exchangeIndex = 0;

  for (const p of room.players) { p.cardsSelected = []; p.hasExchanged = false; }

  emitLog(room, `🔄 Fase de cambio. Máximo ${room.settings.maxCardsChange} carta(s) por jugador.`, 'phase');
  proceedExchange(room);
}

function proceedExchange(room) {
  const gs = room.gameState;
  if (gs.exchangeIndex >= gs.exchangeOrder.length) {
    gs.phase = 'postexchange';
    gs.currentBet = 0; gs.minRaise = gs.bigBlind;
    gs.lastRaiseIndex = -1; gs.actionCount = 0;
    for (const p of room.players) p.bet = 0;

    const firstActor = getNextActiveIndex(room, gs.dealerIndex);
    gs.currentPlayerIndex = firstActor;
    emitLog(room, '🃏 Segunda ronda de apuestas.', 'phase');
    emitRoomState(room);
    startTurnTimer(room);
    return;
  }

  const playerIdx = gs.exchangeOrder[gs.exchangeIndex];
  const player = room.players[playerIdx];
  if (!player || player.folded || player.disconnected || player.eliminated) {
    gs.exchangeIndex++;
    proceedExchange(room);
    return;
  }

  gs.currentPlayerIndex = playerIdx;
  emitRoomState(room);
  startTurnTimer(room);
}

function handleExchangeAction(room, socketId, action, cardIndices) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'exchange') return false;

  const playerIdx = gs.exchangeOrder[gs.exchangeIndex];
  const player = room.players[playerIdx];
  if (!player || player.id !== socketId) return false;
  if (player.hasExchanged) return false;

  clearTurnTimer(room);

  const maxChange = room.settings.maxCardsChange || 3;
  let indices = Array.isArray(cardIndices)
    ? cardIndices.filter(i => Number.isInteger(i) && i >= 0 && i < 5).slice(0, maxChange)
    : [];

  for (const idx of indices) { player.cards[idx] = gs.deck.pop(); }
  player.hasExchanged = true;

  if (indices.length === 0) {
    emitLog(room, `🤚 ${player.name} no cambió cartas.`, 'info');
  } else {
    emitLog(room, `🔄 ${player.name} cambió ${indices.length} carta(s).`, 'info');
  }

  gs.exchangeIndex++;
  proceedExchange(room);
  return true;
}

// ============================================================
// SIDE POTS & SHOWDOWN
// ============================================================
function calculateSidePots(room) {
  const gs = room.gameState;
  const players = room.players.filter(p => p.totalBet > 0 && !p.eliminated);
  const allInLevels = [...new Set(players.filter(p=>p.allIn).map(p=>p.totalBet))].sort((a,b)=>a-b);

  if (allInLevels.length === 0) {
    return [{ amount: gs.pot, eligible: players.filter(p=>!p.folded) }];
  }

  const sidePots = [];
  let prevLevel = 0;

  for (const level of allInLevels) {
    const potAmount = players.reduce((sum,p) => sum + Math.min(p.totalBet,level) - Math.min(p.totalBet,prevLevel), 0);
    const eligible = players.filter(p => !p.folded && p.totalBet >= level);
    if (potAmount > 0 && eligible.length > 0) sidePots.push({ amount: potAmount, eligible });
    prevLevel = level;
  }

  const mainPotRemainder = players.reduce((sum,p) => sum + Math.max(0, p.totalBet - prevLevel), 0);
  const mainEligible = players.filter(p => !p.folded && !p.allIn);
  if (mainPotRemainder > 0 && mainEligible.length > 0) sidePots.push({ amount: mainPotRemainder, eligible: mainEligible });
  else if (mainPotRemainder > 0 && sidePots.length > 0) sidePots[sidePots.length-1].amount += mainPotRemainder;
  else if (mainPotRemainder > 0) sidePots.push({ amount: mainPotRemainder, eligible: players.filter(p=>!p.folded) });

  return sidePots;
}

function endHand(room) {
  const gs = room.gameState;
  clearTurnTimer(room);
  gs.phase = 'showdown';
  gs.reviveRequest = null;

  const active = room.players.filter(p => !p.folded && !p.eliminated && !p.disconnected);
  const isClassic = room.gameMode === 'classic';
  let winners = [];

  if (active.length === 1) {
    active[0].stack += gs.pot;
    emitLog(room, `🏆 ${active[0].name} gana ${gs.pot} fichas sin mostrar.`, 'win');
    winners = [{ player: active[0], amount: gs.pot }];
  } else {
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
      const rem = pot.amount - share * potWinners.length;

      potWinners.forEach((r, i) => {
        const winAmt = share + (i === 0 ? rem : 0);
        r.player.stack += winAmt;
        winners.push({ player: r.player, amount: winAmt, hand: handName(r.hand.score), cards: r.hand.cards });
        emitLog(room, `🏆 ${r.player.name} gana ${winAmt} con ${handName(r.hand.score)}!`, 'win');
      });
    }
  }

  io.to(room.id).emit('showdown', {
    winners: winners.map(w => ({ id: w.player.id, name: w.player.name, amount: w.amount, hand: w.hand, cards: w.cards })),
    players: room.players.map(p => {
      let handStr = '';
      if (p.cards.length >= 2 && !p.cards.includes('back')) {
        const h = isClassic ? bestHandExact(p.cards) : bestHand([...p.cards, ...gs.communityCards]);
        handStr = h ? handName(h.score) : '';
      }
      return { id: p.id, name: p.name, cards: p.cards, hand: handStr };
    })
  });

  emitRoomState(room);

  setTimeout(() => {
    if (!rooms.has(room.id)) return;

    for (const p of room.players) {
      if (!p.eliminated && p.stack <= 0 && !p.disconnected) {
        p.eliminated = true;
        p.status = 'busted';
        p.folded = true;
        p.allIn = false;
        p.cards = [];
        p.waitingNextHand = true;
        emitLog(room, `💀 ${p.name} quedó sin fichas. Puede mirar y pedir revive.`, 'eliminate');
        io.to(p.id).emit('eliminated');
      }
    }

    const remaining = room.players.filter(p=>!p.eliminated && !p.disconnected && p.stack > 0);
    if (remaining.length < MIN_PLAYERS) {
      const busted = room.players.filter(p=>p.eliminated && !p.disconnected && room.settings.allowRevive);
      if (busted.length > 0 && remaining.length >= 1) {
        gs.phase = 'showdown';
        emitLog(room, `⏸️ Queda ${remaining[0].name} con fichas. Esperando posibles solicitudes de revive.`, 'warning');
        emitRoomState(room);
        return;
      }
      if (remaining.length === 1) {
        emitLog(room, `🏆 ${remaining[0].name} gana la partida! 🎉`, 'champion');
        io.to(room.id).emit('gameOver', { winner: remaining[0].name });
        setTimeout(() => { if (rooms.has(room.id)) closeRoom(room, `${remaining[0].name} ganó la partida.`); }, 2500);
      } else {
        setTimeout(() => { if (rooms.has(room.id)) closeRoom(room, 'La partida terminó.'); }, 1000);
      }
      return;
    }

    setTimeout(() => {
      if (!rooms.has(room.id)) return;
      gs.phase = 'waiting';
      gs.dealerIndex = getNextActiveIndex(room, gs.dealerIndex);
      startNewHand(room);
    }, 3000);
  }, 2000);
}

// ============================================================
// REVIVE SYSTEM
// ============================================================
function requestRevive(room, socketId) {
  if (!room.settings.allowRevive) {
    io.to(socketId).emit('error', { msg: 'El revive está desactivado en esta sala.' });
    return;
  }

  const gs = room.gameState;
  if (!gs) return;
  if (gs.reviveRequest) return;

  const player = room.players.find(p => p.id === socketId && p.eliminated);
  if (!player) return;

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && p.stack > 0);
  if (active.length < 1) return;

  gs.reviveRequest = {
    playerId: socketId,
    playerName: player.name,
    votes: {},
    expiresAt: Date.now() + REVIVE_VOTE_TIME
  };

  emitLog(room, `🔄 ${player.name} solicita revivir. ¡Voten!`, 'revive');
  emitRoomState(room);

  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    if (!room.gameState?.reviveRequest || room.gameState.reviveRequest.playerId !== socketId) return;
    if (!room.settings.requireReviveVote) {
      resolveReviveVote(room, false, true);
    } else {
      resolveReviveVote(room, true);
    }
  }, REVIVE_VOTE_TIME + 500);
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

  if (timeout) {
    emitLog(room, `❌ Votación expiró. ${req.playerName} no revivió.`, 'info');
    emitRoomState(room);
    return;
  }

  let majority = autoApprove;
  if (!autoApprove) {
    const active = room.players.filter(p => !p.eliminated && !p.disconnected && p.stack > 0);
    const yesVotes = active.filter(p => req.votes[p.id] === true).length;
    majority = yesVotes > active.length / 2;
  }

  if (majority) {
    const player = room.players.find(p => p.id === req.playerId);
    if (player) {
      player.eliminated = false;
      player.status = 'revivedNextHand';
      const revStack = room.settings.reviveStack || REVIVE_STACK;
      player.stack = revStack;
      player.folded = true;
      player.waitingNextHand = true;
      player.cards = [];
      room.spectators = room.spectators.filter(s => s.id !== player.id);
      emitLog(room, `✅ ${player.name} revivió con ${revStack} fichas! Jugará la próxima mano.`, 'revive');
      io.to(player.id).emit('revived', { stack: revStack });

      // If game was paused, restart
      if (gs.phase === 'waiting' || gs.phase === 'showdown') {
        setTimeout(() => { if (rooms.has(room.id)) startNewHand(room); }, 2000);
      }
    }
  } else {
    emitLog(room, `❌ ${req.playerName} no obtuvo suficientes votos para revivir.`, 'info');
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
  emitLog(room, `🚫 ${target.name} fue expulsado.`, 'kick');
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
  bannedPlayers.get(room.id).add(target.name);
  emitLog(room, `🔨 ${target.name} fue baneado.`, 'ban');
  io.to(targetId).emit('banned', { reason: 'Fuiste baneado de esta sala.' });
  removePlayerFromRoom(room, targetId, false);
  return true;
}

function addChips(room, hostSocketId, targetId, amount) {
  if (!assertHost(room, hostSocketId)) return false;
  const amt = validateNumber(amount, 1, 1000000);
  if (amt === null) return false;
  const target = room.players.find(p => p.id === targetId);
  if (!target) return false;
  target.stack += amt;
  if (target.eliminated && target.stack > 0) {
    target.eliminated = false;
    target.status = 'revivedNextHand';
    target.waitingNextHand = true;
    room.spectators = room.spectators.filter(s => s.id !== targetId);
    io.to(targetId).emit('revived', { stack: target.stack });
  }
  emitLog(room, `💰 ${amt} fichas dadas a ${target.name}.`, 'chips');
  emitRoomState(room);
  return true;
}

function restartGame(room, hostSocketId) {
  if (!assertHost(room, hostSocketId)) return false;
  clearTurnTimer(room);
  for (const p of room.players) {
    p.stack = room.startingStack; p.eliminated = false; p.status = 'active';
    p.folded = false; p.allIn = false;
    p.bet = 0; p.totalBet = 0; p.cards = [];
    p.waitingNextHand = false; p.hasExchanged = false; p.cardsSelected = [];
  }
  room.spectators = [];
  room.gameState = null;
  room.state = 'waiting';
  room.hasStarted = false;
  emitLog(room, '🔄 El anfitrión reinició la partida.', 'info');
  emitRoomState(room);
  broadcastRoomList();
  return true;
}

function endGame(room, hostSocketId) {
  if (!assertHost(room, hostSocketId)) return false;
  clearTurnTimer(room);
  emitLog(room, '🛑 El anfitrión terminó la partida.', 'info');
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
  const sb = validateNumber(settings.smallBlind, 1, 10000);
  if (sb !== null && room.state !== 'playing') { s.smallBlind = sb; }
  const bb = validateNumber(settings.bigBlind, 2, 20000);
  if (bb !== null && room.state !== 'playing') { s.bigBlind = bb; }
  const revStack = validateNumber(settings.reviveStack, 100, 100000);
  if (revStack !== null) s.reviveStack = revStack;
  const maxCC = validateNumber(settings.maxCardsChange, 0, 5);
  if (maxCC !== null) s.maxCardsChange = maxCC;
  emitLog(room, '⚙️ Configuración actualizada.', 'info');
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

    if (disconnect) {
      player.disconnected = true;
      player.status = 'disconnected';
      emitLog(room, `📡 ${player.name} se desconectó.`, 'disconnect');

      const gs = room.gameState;
      if (gs && gs.phase !== 'waiting' && gs.phase !== 'showdown') {
        if (gs.phase === 'exchange') {
          const curExIdx = gs.exchangeOrder[gs.exchangeIndex];
          if (curExIdx === playerIdx && !player.hasExchanged) {
            player.hasExchanged = true;
            gs.exchangeIndex++;
            clearTurnTimer(room);
            proceedExchange(room);
          }
        } else if (gs.currentPlayerIndex === playerIdx && !player.folded && !player.allIn) {
          player.folded = true;
          clearTurnTimer(room);
          const active = getActivePlayers(room);
          if (active.length <= 1) {
            endHand(room);
          } else {
            advanceTurnAfterFold(room);
          }
        }
      }

      // Schedule removal after reconnect window
      if (player._removalTimer) clearTimeout(player._removalTimer);
      player._removalTimer = setTimeout(() => {
        if (!rooms.has(room.id)) return;
        if (!player.disconnected) return; // Reconnected
        const stillIdx = room.players.findIndex(p => p.id === socketId);
        if (stillIdx !== -1) room.players.splice(stillIdx, 1);
        socketToRoom.delete(socketId);
        socketToPlayer.delete(socketId);
        checkRoomEmpty(room);
        if (!rooms.has(room.id)) return;
        emitRoomState(room);
        broadcastRoomList();
      }, RECONNECT_TIMEOUT);

    } else {
      // Immediate: kick/ban/leave
      const gs = room.gameState;
      if (gs && gs.phase !== 'waiting' && gs.phase !== 'showdown') {
        if (gs.phase === 'exchange') {
          const curExIdx = gs.exchangeOrder[gs.exchangeIndex];
          if (curExIdx === playerIdx && !player.hasExchanged) {
            player.hasExchanged = true;
            gs.exchangeIndex++;
            clearTurnTimer(room);
            proceedExchange(room);
          }
        } else if (!player.folded && !player.allIn) {
          player.folded = true;
          clearTurnTimer(room);
          const active = getActivePlayers(room);
          if (active.length <= 1) {
            endHand(room);
          } else if (gs.currentPlayerIndex === playerIdx) {
            advanceTurnAfterFold(room);
          }
        }
      }
      if (player._removalTimer) clearTimeout(player._removalTimer);
      room.players.splice(playerIdx, 1);
      socketToRoom.delete(socketId);
      socketToPlayer.delete(socketId);
    }
  } else if (spectatorIdx !== -1) {
    playerName = room.spectators[spectatorIdx].name;
    room.spectators.splice(spectatorIdx, 1);
    socketToRoom.delete(socketId);
  }

  // Host reassignment
  if (room.hostSocketId === socketId) {
    const newHost = room.players.find(p => !p.disconnected && !p.eliminated && p.stack > 0) || room.players.find(p => !p.disconnected);
    if (newHost && !room.settings.closeOnHostLeave) {
      room.hostSocketId = newHost.id;
      emitLog(room, `👑 ${playerName} (anfitrión) se fue. Nuevo anfitrión: ${newHost.name}.`, 'info');
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
    const activeLeft = room.players.filter(p => !p.eliminated && !p.disconnected && p.stack > 0);
    const bustedWithRevive = room.players.filter(p => p.eliminated && !p.disconnected && room.settings.allowRevive);
    if (activeLeft.length < MIN_PLAYERS && bustedWithRevive.length === 0) {
      const msg = activeLeft[0] ? `🏆 ${activeLeft[0].name} gana. La sala se cerró.` : 'La partida terminó.';
      setTimeout(() => { if (rooms.has(room.id)) closeRoom(room, msg); }, 1500);
      return;
    }
  }

  emitRoomState(room);
  broadcastRoomList();
}

function advanceTurnAfterFold(room) {
  const gs = room.gameState;
  if (!gs) return;
  clearTurnTimer(room);

  const active = getActivePlayers(room);
  if (active.length <= 1) { endHand(room); return; }

  let next = getNextActiveIndex(room, gs.currentPlayerIndex);
  let safety = 0;
  while (room.players[next]?.allIn && safety < room.players.length) {
    const n2 = getNextActiveIndex(room, next);
    if (n2 === next) break;
    next = n2;
    safety++;
  }
  gs.currentPlayerIndex = next;
  emitRoomState(room);
  startTurnTimer(room);
}

function checkRoomEmpty(room) {
  const connected = room.players.filter(p => !p.disconnected).length + room.spectators.length;
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

      const roomId = crypto.randomBytes(4).toString('hex');
      const room = createRoom(roomId, name, socket.id, playerName, password, maxPlayers, startingStack, gameMode);
      const player = createPlayer(socket.id, playerName, room.startingStack);
      player.seatIndex = 0;
      room.players.push(player);
      rooms.set(roomId, room);
      socketToRoom.set(socket.id, roomId);
      socketToPlayer.set(socket.id, player);
      socket.join(roomId);
      socket.emit('roomJoined', { roomId, isHost: true, gameMode });
      emitRoomState(room);
      broadcastRoomList();
      emitLog(room, `👑 ${playerName} creó la sala. Modo: ${gameMode === 'classic' ? 'Póker Clásico' : 'Texas Hold\'em'}`, 'info');
    } catch(e) { socket.emit('error', { msg: 'Error al crear sala.' }); }
  });

  socket.on('joinRoom', (data) => {
    try {
      if (socketToRoom.has(socket.id)) return socket.emit('error', { msg: 'Ya estás en una sala.' });
      if (!data || typeof data !== 'object') return socket.emit('error', { msg: 'Datos inválidos.' });
      const room = rooms.get(data.roomId);
      if (!room) return socket.emit('error', { msg: 'Sala no encontrada.' });
      const playerName = sanitize(data.playerName) || 'Player';

      if (bannedPlayers.has(room.id) && bannedPlayers.get(room.id).has(playerName)) {
        return socket.emit('banned', { reason: 'Estás baneado de esta sala.' });
      }
      if (room.password && room.password !== data.password) {
        return socket.emit('error', { msg: 'Contraseña incorrecta.' });
      }

      // Try reconnect
      const disconnectedPlayer = room.players.find(p => p.name === playerName && p.disconnected);
      if (disconnectedPlayer) {
        const oldId = disconnectedPlayer.id;
        if (disconnectedPlayer._removalTimer) {
          clearTimeout(disconnectedPlayer._removalTimer);
          disconnectedPlayer._removalTimer = null;
        }
        disconnectedPlayer.id = socket.id;
        disconnectedPlayer.disconnected = false;
        if (room.hostSocketId === oldId) room.hostSocketId = socket.id;
        socketToRoom.delete(oldId);
        socketToPlayer.delete(oldId);
        socketToRoom.set(socket.id, room.id);
        socketToPlayer.set(socket.id, disconnectedPlayer);
        socket.join(room.id);
        const isHost = room.hostSocketId === socket.id;
        socket.emit('roomJoined', { roomId: room.id, isHost, gameMode: room.gameMode });
        if (isHost) socket.emit('becameHost');
        emitLog(room, `📡 ${playerName} reconectado.`, 'info');
        emitRoomState(room);
        return;
      }

      // Spectator check
      const seatedCount = room.players.filter(p=>!p.disconnected && !p.eliminated && p.stack > 0).length;
      if (seatedCount >= room.maxPlayers || room.state === 'playing') {
        if (!room.settings.allowSpectators) {
          return socket.emit('error', { msg: 'Sala llena.' });
        }
        room.spectators.push({ id: socket.id, name: playerName, lastChat: 0 });
        socketToRoom.set(socket.id, room.id);
        socket.join(room.id);
        socket.emit('roomJoined', { roomId: room.id, isHost: false, isSpectator: true, gameMode: room.gameMode });
        emitLog(room, `👁️ ${playerName} se unió como espectador.`, 'info');
        emitRoomState(room);
        broadcastRoomList();
        return;
      }

      if (room.players.length >= room.maxPlayers) {
        return socket.emit('error', { msg: 'Sala llena.' });
      }

      const player = createPlayer(socket.id, playerName, room.startingStack);
      player.seatIndex = room.players.length;
      if (room.state === 'playing') { player.waitingNextHand = true; player.folded = true; }
      room.players.push(player);
      socketToRoom.set(socket.id, room.id);
      socketToPlayer.set(socket.id, player);
      socket.join(room.id);
      socket.emit('roomJoined', { roomId: room.id, isHost: false, gameMode: room.gameMode });
      emitLog(room, room.state === 'playing'
        ? `⏳ ${playerName} se unió y jugará desde la próxima mano.`
        : `✅ ${playerName} se unió a la sala.`, 'join');
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
    if (!data || typeof data !== 'object') return;
    const action = data.action;
    const amount = parseInt(data.amount) || 0;
    if (!['fold','check','call','raise','allin'].includes(action)) return;
    handleAction(room, socket.id, action, amount);
  });

  socket.on('exchangeCards', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room || room.state !== 'playing') return;
    const indices = Array.isArray(data?.indices) ? data.indices : [];
    handleExchangeAction(room, socket.id, 'exchange', indices);
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
    emitLog(room, `🚪 ${getPlayerName(socket.id, room)} abandonó la sala.`, 'leave');
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
server.listen(PORT, () => {
  console.log(`🃏 Royal Poker Server running on port ${PORT}`);
  console.log(`   → http://localhost:${PORT}`);
});
