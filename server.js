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
  // Get best 5-card hand from up to 7 cards
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
  // Ace-low straight
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
const bannedPlayers = new Map(); // roomId -> Set of playerNames

// ============================================================
// ROOM FACTORY
// ============================================================
function createRoom(id, name, hostId, hostName, password, maxPlayers, startingStack) {
  return {
    id,
    name,
    hostId,
    hostSocketId: hostId,
    password: password || '',
    maxPlayers: Math.min(Math.max(parseInt(maxPlayers)||6, MIN_PLAYERS), MAX_PLAYERS),
    startingStack: Math.max(parseInt(startingStack)||DEFAULT_STACK, 100),
    players: [],
    spectators: [],
    state: 'waiting', // waiting, playing
    hasStarted: false,
    gameState: null,
    createdAt: Date.now()
  };
}

function createPlayer(socketId, name, stack) {
  return {
    id: socketId,
    name: sanitize(name),
    stack,
    bet: 0,
    totalBet: 0,
    cards: [],
    folded: false,
    allIn: false,
    disconnected: false,
    eliminated: false,
    seatIndex: -1,
    lastAction: 0,
    reviveVote: null,
    waitingNextHand: false
  };
}

function sanitize(str) {
  if (typeof str !== 'string') return 'Player';
  return str.replace(/[<>&"']/g, '').trim().slice(0, 20) || 'Player';
}

// ============================================================
// GAME STATE FACTORY
// ============================================================
function createGameState(room) {
  return {
    deck: shuffle(createDeck()),
    communityCards: [],
    pot: 0,
    sidePots: [],
    currentPlayerIndex: -1,
    dealerIndex: 0,
    smallBlindIndex: 1,
    bigBlindIndex: 2,
    phase: 'waiting', // waiting, preflop, flop, turn, river, showdown
    smallBlind: 100,
    bigBlind: 200,
    currentBet: 0,
    minRaise: 20,
    lastRaiseIndex: -1,
    actionCount: 0,
    turnTimer: null,
    handNumber: 0,
    reviveRequest: null
  };
}

// ============================================================
// BROADCAST HELPERS
// ============================================================
function broadcastRoomList() {
  const list = getRoomList();
  io.emit('roomList', list);
}

function getRoomList() {
  return Array.from(rooms.values()).map(r => ({
    id: r.id,
    name: r.name,
    players: r.players.filter(p=>!p.eliminated).length,
    maxPlayers: r.maxPlayers,
    hasPassword: !!r.password,
    state: r.state,
    spectators: r.spectators.length,
    avgStack: getAvgStack(r),
    started: r.state === 'playing'
  }));
}

function getAvgStack(room) {
  const active = room.players.filter(p=>!p.eliminated && !p.disconnected);
  if (!active.length) return 0;
  return Math.round(active.reduce((s,p)=>s+p.stack,0)/active.length);
}

function emitRoomState(room) {
  // Send different views to each player (hide opponent cards)
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
  const players = room.players.map(p => {
    const isMe = p.id === socketId;
    let cards = [];
    if (gs && gs.phase === 'showdown') {
      cards = p.cards; // reveal all at showdown
    } else if (isMe) {
      cards = p.cards; // show own cards
    } else {
      cards = p.cards.map(() => 'back'); // hide opponent cards
    }
    return {
      id: p.id,
      name: p.name,
      stack: p.stack,
      bet: p.bet,
      totalBet: p.totalBet,
      cards,
      folded: p.folded,
      allIn: p.allIn,
      disconnected: p.disconnected,
      eliminated: p.eliminated,
      seatIndex: p.seatIndex,
      isHost: p.id === room.hostSocketId,
      waitingNextHand: !!p.waitingNextHand
    };
  });

  return {
    roomId: room.id,
    roomName: room.name,
    hostId: room.hostSocketId,
    state: room.state,
    players,
    spectators: room.spectators.map(s=>({id:s.id,name:s.name})),
    myId: socketId,
    isSpectator,
    gameState: gs ? {
      communityCards: gs.communityCards,
      pot: gs.pot,
      sidePots: gs.sidePots,
      currentPlayerIndex: gs.currentPlayerIndex,
      dealerIndex: gs.dealerIndex,
      smallBlindIndex: gs.smallBlindIndex,
      bigBlindIndex: gs.bigBlindIndex,
      phase: gs.phase,
      smallBlind: gs.smallBlind,
      bigBlind: gs.bigBlind,
      currentBet: gs.currentBet,
      minRaise: gs.minRaise,
      handNumber: gs.handNumber,
      reviveRequest: gs.reviveRequest
    } : null
  };
}

function emitLog(room, msg, type='info') {
  io.to(room.id).emit('chatMessage', { system: true, text: msg, type, ts: Date.now() });
}

// ============================================================
// ROOM CLOSE HELPERS
// ============================================================
function closeRoom(room, reason='La sala fue cerrada.') {
  if (!room || !rooms.has(room.id)) return false;
  clearTurnTimer(room);
  io.to(room.id).emit('gameEnded', { reason });
  for (const p of room.players) {
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
  const activePlayers = room.players.filter(p => !p.eliminated);
  if (activePlayers.length < MIN_PLAYERS) {
    emitLog(room, 'Se necesitan al menos 2 jugadores para iniciar.', 'error');
    return;
  }

  room.state = 'playing';
  room.hasStarted = true;
  const gs = createGameState(room);
  room.gameState = gs;

  // Reset all players
  for (const p of room.players) {
    p.folded = false;
    p.allIn = false;
    p.bet = 0;
    p.totalBet = 0;
    p.cards = [];
  }

  emitLog(room, '🃏 ¡Partida iniciada!', 'success');
  startNewHand(room);
  broadcastRoomList();
}

function startNewHand(room) {
  const gs = room.gameState;
  // Players who joined during the previous hand become active now.
  for (const p of room.players) { p.waitingNextHand = false; }
  gs.handNumber++;

  // Reset deck and community
  gs.deck = shuffle(createDeck());
  gs.communityCards = [];
  gs.pot = 0;
  gs.sidePots = [];
  gs.currentBet = 0;
  gs.minRaise = gs.bigBlind;
  gs.actionCount = 0;
  gs.reviveRequest = null;

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.waitingNextHand);
  if (active.length < MIN_PLAYERS) {
    if (room.hasStarted) {
      const winner = active[0]?.name;
      const msg = winner ? `🏆 ${winner} gana la partida. La sala se cerrará.` : 'La partida terminó. La sala se cerrará.';
      emitLog(room, msg, 'champion');
      setTimeout(() => closeRoom(room, msg), 1200);
    } else {
      room.state = 'waiting';
      emitLog(room, '⏸️ Esperando jugadores...', 'warning');
      emitRoomState(room);
      broadcastRoomList();
    }
    return;
  }

  // Reset player hand state
  for (const p of room.players) {
    p.folded = p.eliminated || p.disconnected || p.waitingNextHand;
    p.allIn = false;
    p.bet = 0;
    p.totalBet = 0;
    p.cards = [];
  }

  // Advance dealer
  const activeIndices = active.map(p => room.players.indexOf(p));
  let dealerPos = gs.dealerIndex;

  // Find next valid dealer
  const nextDealer = getNextActiveIndex(room, dealerPos);
  gs.dealerIndex = nextDealer;

  const activePl = room.players.filter(p=>!p.folded);
  const nActive = activePl.length;

  // Blinds
  let sbIdx, bbIdx;
  if (nActive === 2) {
    sbIdx = getNextActiveIndex(room, gs.dealerIndex - 1);
    bbIdx = getNextActiveIndex(room, sbIdx);
  } else {
    sbIdx = getNextActiveIndex(room, gs.dealerIndex);
    bbIdx = getNextActiveIndex(room, sbIdx);
  }
  gs.smallBlindIndex = sbIdx;
  gs.bigBlindIndex = bbIdx;

  // Post blinds
  const sbPlayer = room.players[sbIdx];
  const bbPlayer = room.players[bbIdx];

  postBlind(sbPlayer, gs, gs.smallBlind);
  postBlind(bbPlayer, gs, gs.bigBlind);
  gs.currentBet = gs.bigBlind;
  gs.minRaise = gs.bigBlind;

  // Deal cards
  for (let i = 0; i < 2; i++) {
    for (const p of room.players) {
      if (!p.folded && !p.waitingNextHand) p.cards.push(gs.deck.pop());
    }
  }

  gs.phase = 'preflop';
  gs.lastRaiseIndex = bbIdx;

  // UTG acts first preflop
  const utg = getNextActiveIndex(room, bbIdx);
  gs.currentPlayerIndex = utg;

  emitLog(room, `🃏 Mano #${gs.handNumber} | Dealer: ${room.players[gs.dealerIndex]?.name} | SB: ${sbPlayer?.name} | BB: ${bbPlayer?.name}`, 'info');
  emitRoomState(room);
  startTurnTimer(room);
}

function postBlind(player, gs, amount) {
  const actual = Math.min(amount, player.stack);
  player.bet += actual;
  player.totalBet += actual;
  player.stack -= actual;
  gs.pot += actual;
  if (player.stack === 0) player.allIn = true;
}

function getNextActiveIndex(room, fromIndex) {
  const n = room.players.length;
  let idx = ((fromIndex + 1) % n + n) % n;
  let count = 0;
  while ((room.players[idx].folded || room.players[idx].eliminated || room.players[idx].disconnected) && count < n) {
    idx = (idx + 1) % n;
    count++;
  }
  return idx;
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.folded && !p.eliminated && !p.disconnected && !p.waitingNextHand);
}

function startTurnTimer(room) {
  const gs = room.gameState;
  if (gs.turnTimer) clearTimeout(gs.turnTimer);

  const currentPlayer = room.players[gs.currentPlayerIndex];
  if (!currentPlayer) return;

  io.to(room.id).emit('turnStart', {
    playerId: currentPlayer.id,
    timeout: TURN_TIMEOUT,
    ts: Date.now()
  });

  gs.turnTimer = setTimeout(() => {
    // Auto fold on timeout
    const p = room.players[gs.currentPlayerIndex];
    if (p && !p.folded) {
      emitLog(room, `⏱️ ${p.name} agotó su tiempo. Fold automático.`, 'warning');
      handleAction(room, p.id, 'fold', 0);
    }
  }, TURN_TIMEOUT);
}

function clearTurnTimer(room) {
  if (room.gameState && room.gameState.turnTimer) {
    clearTimeout(room.gameState.turnTimer);
    room.gameState.turnTimer = null;
  }
}

function handleAction(room, socketId, action, amount) {
  const gs = room.gameState;
  if (!gs || gs.phase === 'waiting' || gs.phase === 'showdown') return false;

  const player = room.players[gs.currentPlayerIndex];
  if (!player || player.id !== socketId) return false;
  if (player.folded || player.allIn) return false;

  // Action cooldown
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
      player.bet += actual;
      player.totalBet += actual;
      player.stack -= actual;
      gs.pot += actual;
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
      const raiseAmount = parseInt(amount);
      if (isNaN(raiseAmount)) return false;
      const totalNeeded = gs.currentBet + Math.max(raiseAmount, gs.minRaise);
      const raiseTotal = totalNeeded - player.bet;
      if (raiseTotal <= 0 || raiseTotal > player.stack) return false;

      gs.minRaise = raiseAmount;
      player.bet += raiseTotal;
      player.totalBet += raiseTotal;
      player.stack -= raiseTotal;
      gs.pot += raiseTotal;
      gs.currentBet = player.bet;
      gs.lastRaiseIndex = gs.currentPlayerIndex;
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
        gs.lastRaiseIndex = gs.currentPlayerIndex;
        gs.actionCount = 0;
      }

      player.bet += allInAmount;
      player.totalBet += allInAmount;
      gs.pot += allInAmount;
      player.stack = 0;
      player.allIn = true;
      emitLog(room, `💥 ${player.name} va ALL-IN con ${player.totalBet}!`, 'allin');
      valid = true;
      break;
    }
  }

  if (!valid) return false;

  gs.actionCount++;

  // Check if hand is over or advance
  const active = getActivePlayers(room);
  if (active.length <= 1) {
    endHand(room);
    return true;
  }

  // Check if all active players are all-in or betting is even
  const bettingPlayers = active.filter(p => !p.allIn);
  const allEven = bettingPlayers.every(p => p.bet === gs.currentBet);

  if (bettingPlayers.length === 0 || (allEven && gs.actionCount >= bettingPlayers.length && gs.currentPlayerIndex !== gs.lastRaiseIndex)) {
    advancePhase(room);
    return true;
  }

  // Next player
  let nextIdx = getNextActiveIndex(room, gs.currentPlayerIndex);
  // Skip all-ins
  let tries = 0;
  while (room.players[nextIdx].allIn && tries < room.players.length) {
    nextIdx = getNextActiveIndex(room, nextIdx);
    tries++;
  }

  // Check if we looped back and betting is done
  if (nextIdx === gs.lastRaiseIndex || allEven && nextIdx === gs.bigBlindIndex && gs.phase === 'preflop' && gs.actionCount >= active.length) {
    advancePhase(room);
    return true;
  }

  // Re-check after skipping allins
  const bettingLeft = getActivePlayers(room).filter(p=>!p.allIn);
  const stillUneven = bettingLeft.some(p=>p.bet < gs.currentBet);
  if (!stillUneven && !room.players[nextIdx].allIn) {
    if (nextIdx === gs.lastRaiseIndex) {
      advancePhase(room);
      return true;
    }
  }

  gs.currentPlayerIndex = nextIdx;
  emitRoomState(room);
  startTurnTimer(room);
  return true;
}

function advancePhase(room) {
  const gs = room.gameState;
  clearTurnTimer(room);

  // Reset bets
  for (const p of room.players) { p.bet = 0; }
  gs.actionCount = 0;

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
      endHand(room);
      return;
  }

  gs.currentBet = 0;
  gs.minRaise = gs.bigBlind;
  gs.lastRaiseIndex = -1;

  // First to act post-flop: first active left of dealer
  const firstActor = getNextActiveIndex(room, gs.dealerIndex);
  gs.currentPlayerIndex = firstActor;

  // If all remaining are all-in, run out the board
  const notAllIn = getActivePlayers(room).filter(p=>!p.allIn);
  if (notAllIn.length === 0) {
    setTimeout(() => advancePhase(room), 1500);
    emitRoomState(room);
    return;
  }

  // Skip if current player is all-in
  if (room.players[gs.currentPlayerIndex].allIn) {
    gs.currentPlayerIndex = getNextActiveIndex(room, gs.currentPlayerIndex);
  }

  emitRoomState(room);
  startTurnTimer(room);
}

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
    const potAmount = players.reduce((sum, p) => sum + Math.min(p.totalBet, level) - Math.min(p.totalBet, prevLevel), 0);
    const eligible = players.filter(p => !p.folded && p.totalBet >= level);
    if (potAmount > 0 && eligible.length > 0) sidePots.push({ amount: potAmount, eligible });
    prevLevel = level;
  }

  const mainPotRemainder = players.reduce((sum,p) => sum + Math.max(0, p.totalBet - prevLevel), 0);
  const mainEligible = players.filter(p => !p.folded && !p.allIn);
  if (mainPotRemainder > 0 && mainEligible.length > 0) sidePots.push({ amount: mainPotRemainder, eligible: mainEligible });
  else if (mainPotRemainder > 0) sidePots[sidePots.length-1].amount += mainPotRemainder;

  return sidePots;
}

function endHand(room) {
  const gs = room.gameState;
  clearTurnTimer(room);
  gs.phase = 'showdown';
  gs.reviveRequest = null;

  const active = room.players.filter(p => !p.folded && !p.eliminated);

  let winners = [];

  if (active.length === 1) {
    // Uncontested
    active[0].stack += gs.pot;
    emitLog(room, `🏆 ${active[0].name} gana ${gs.pot} fichas sin mostrar.`, 'win');
    winners = [{ player: active[0], amount: gs.pot }];
  } else {
    // Evaluate hands
    const sidePots = calculateSidePots(room);
    gs.sidePots = sidePots;

    for (const pot of sidePots) {
      const handResults = pot.eligible.map(p => {
        const allCards = [...p.cards, ...gs.communityCards];
        const hand = bestHand(allCards);
        return { player: p, hand };
      }).filter(r => r.hand);

      if (!handResults.length) continue;

      handResults.sort((a,b) => compareScores(b.hand.score, a.hand.score));
      const best = handResults[0].hand.score;
      const potWinners = handResults.filter(r => compareScores(r.hand.score, best) === 0);
      const share = Math.floor(pot.amount / potWinners.length);
      const remainder = pot.amount - share * potWinners.length;

      potWinners.forEach((r, i) => {
        r.player.stack += share + (i === 0 ? remainder : 0);
        winners.push({ player: r.player, amount: share, hand: handName(r.hand.score), cards: r.hand.cards });
        emitLog(room, `🏆 ${r.player.name} gana ${share} con ${handName(r.hand.score)}!`, 'win');
      });
    }
  }

  // Emit showdown info
  io.to(room.id).emit('showdown', {
    winners: winners.map(w => ({ id: w.player.id, name: w.player.name, amount: w.amount, hand: w.hand, cards: w.cards })),
    players: room.players.map(p => ({ id: p.id, name: p.name, cards: p.cards, hand: p.cards.length > 0 ? (() => { const h = bestHand([...p.cards,...gs.communityCards]); return h ? handName(h.score) : ''; })() : '' }))
  });

  emitRoomState(room);

  // Eliminate broke players
  setTimeout(() => {
    for (const p of room.players) {
      if (!p.eliminated && p.stack <= 0 && !p.disconnected) {
        p.eliminated = true;
        emitLog(room, `💀 ${p.name} quedó eliminado.`, 'eliminate');
        // Move to spectators list
        room.spectators.push({ id: p.id, name: p.name });
        io.to(p.id).emit('eliminated');
      }
    }

    // Check if game should continue
    const remaining = room.players.filter(p=>!p.eliminated && !p.disconnected);
    if (remaining.length < MIN_PLAYERS) {
      if (remaining.length === 1) {
        emitLog(room, `🏆 ${remaining[0].name} gana la partida! 🎉`, 'champion');
        io.to(room.id).emit('gameOver', { winner: remaining[0].name });
        setTimeout(() => closeRoom(room, `${remaining[0].name} ganó la partida. La sala se cerró.`), 2500);
      } else {
        setTimeout(() => closeRoom(room, 'La partida terminó. La sala se cerró.'), 1000);
      }
      return;
    }

    // Check revive requests
    checkReviveRequests(room);

    // Next hand
    setTimeout(() => {
      gs.phase = 'waiting';
      // Advance dealer
      gs.dealerIndex = getNextActiveIndex(room, gs.dealerIndex);
      startNewHand(room);
    }, 3000);
  }, 2000);
}

function checkReviveRequests(room) {
  // No-op: revive is initiated by eliminated players explicitly
}

// ============================================================
// REVIVE SYSTEM
// ============================================================
function requestRevive(room, socketId) {
  const gs = room.gameState;
  const player = room.players.find(p => p.id === socketId && p.eliminated);
  if (!player) return;
  if (gs && gs.reviveRequest) return; // Already a request pending

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.waitingNextHand);
  if (active.length < 2) return;

  if (!gs) return;
  gs.reviveRequest = {
    playerId: socketId,
    playerName: player.name,
    votes: {},
    expiresAt: Date.now() + REVIVE_VOTE_TIME
  };

  emitLog(room, `🔄 ${player.name} solicita revivir. ¡Voten!`, 'revive');
  emitRoomState(room);

  // Auto-expire
  setTimeout(() => {
    if (!room.gameState || !room.gameState.reviveRequest || room.gameState.reviveRequest.playerId !== socketId) return;
    resolveReviveVote(room, true); // timeout = auto reject
  }, REVIVE_VOTE_TIME + 500);
}

function voteRevive(room, socketId, vote) {
  const gs = room.gameState;
  if (!gs || !gs.reviveRequest) return;
  const voter = room.players.find(p => p.id === socketId && !p.eliminated);
  if (!voter) return;

  gs.reviveRequest.votes[socketId] = vote;
  emitRoomState(room);

  // Check if all active voted
  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.waitingNextHand);
  const voted = active.filter(p => gs.reviveRequest.votes[p.id] !== undefined);
  if (voted.length >= active.length) {
    resolveReviveVote(room, false);
  }
}

function resolveReviveVote(room, timeout) {
  const gs = room.gameState;
  if (!gs || !gs.reviveRequest) return;

  const req = gs.reviveRequest;
  gs.reviveRequest = null;

  if (timeout) {
    emitLog(room, `❌ Votación expiró. ${req.playerName} no revivió.`, 'info');
    emitRoomState(room);
    return;
  }

  const active = room.players.filter(p => !p.eliminated && !p.disconnected && !p.waitingNextHand);
  const yesVotes = active.filter(p => req.votes[p.id] === true).length;
  const majority = yesVotes > active.length / 2;

  if (majority) {
    const player = room.players.find(p => p.id === req.playerId);
    if (player) {
      player.eliminated = false;
      player.stack = REVIVE_STACK;
      player.folded = true;
      player.cards = [];
      room.spectators = room.spectators.filter(s => s.id !== player.id);
      emitLog(room, `✅ ${player.name} revivió con ${REVIVE_STACK} fichas!`, 'revive');
      io.to(player.id).emit('revived', { stack: REVIVE_STACK });
    }
  } else {
    emitLog(room, `❌ ${req.playerName} no obtuvo suficientes votos para revivir.`, 'info');
  }

  emitRoomState(room);
}

// ============================================================
// HOST ACTIONS
// ============================================================
function kickPlayer(room, hostSocketId, targetId) {
  if (room.hostSocketId !== hostSocketId) return false;
  const target = room.players.find(p => p.id === targetId);
  if (!target) return false;

  emitLog(room, `🚫 ${target.name} fue expulsado por el anfitrión.`, 'kick');
  io.to(targetId).emit('kicked', { reason: 'Fuiste expulsado por el anfitrión.' });

  removePlayerFromRoom(room, targetId);
  return true;
}

function banPlayer(room, hostSocketId, targetId) {
  if (room.hostSocketId !== hostSocketId) return false;
  const target = room.players.find(p => p.id === targetId);
  if (!target) return false;

  if (!bannedPlayers.has(room.id)) bannedPlayers.set(room.id, new Set());
  bannedPlayers.get(room.id).add(target.name);

  emitLog(room, `🔨 ${target.name} fue baneado de la sala.`, 'ban');
  io.to(targetId).emit('banned', { reason: 'Fuiste baneado de esta sala.' });

  removePlayerFromRoom(room, targetId);
  return true;
}

function addChips(room, hostSocketId, targetId, amount) {
  if (room.hostSocketId !== hostSocketId) return false;
  amount = parseInt(amount);
  if (isNaN(amount) || amount <= 0 || amount > 1000000) return false;

  const target = room.players.find(p => p.id === targetId) || room.players.find(p => p.id === hostSocketId && targetId === hostSocketId);
  // Allow host to give to themselves
  const actualTarget = room.players.find(p => p.id === targetId);
  if (!actualTarget) return false;

  actualTarget.stack += amount;
  if (actualTarget.eliminated && actualTarget.stack > 0) {
    actualTarget.eliminated = false;
    room.spectators = room.spectators.filter(s => s.id !== targetId);
    io.to(targetId).emit('revived', { stack: actualTarget.stack });
  }

  emitLog(room, `💰 El anfitrión dio ${amount} fichas a ${actualTarget.name}.`, 'chips');
  emitRoomState(room);
  return true;
}

function restartGame(room, hostSocketId) {
  if (room.hostSocketId !== hostSocketId) return false;
  clearTurnTimer(room);

  for (const p of room.players) {
    p.stack = room.startingStack;
    p.eliminated = false;
    p.folded = false;
    p.allIn = false;
    p.bet = 0;
    p.totalBet = 0;
    p.cards = [];
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
  if (room.hostSocketId !== hostSocketId) return false;
  clearTurnTimer(room);

  emitLog(room, '🛑 El anfitrión terminó la partida.', 'info');
  return closeRoom(room, 'El anfitrión cerró la sala.');
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
      emitLog(room, `📡 ${player.name} se desconectó.`, 'disconnect');

      // Auto fold if it's their turn
      if (room.gameState && room.players[room.gameState.currentPlayerIndex]?.id === socketId) {
        player.folded = true;
        const active = getActivePlayers(room);
        if (active.length <= 1) {
          endHand(room);
        } else {
          advanceTurnAfterFold(room);
        }
      }

      // Schedule removal if no reconnect
      setTimeout(() => {
        if (player.disconnected) {
          room.players.splice(playerIdx, 1);
          socketToRoom.delete(socketId);
          socketToPlayer.delete(socketId);
          checkRoomEmpty(room);
          emitRoomState(room);
          broadcastRoomList();
        }
      }, RECONNECT_TIMEOUT);
    } else {
      // Immediate removal (kick/ban/leave)
      if (room.gameState && !player.folded && !player.allIn) {
        player.folded = true;
        const active = getActivePlayers(room);
        if (active.length <= 1) {
          endHand(room);
        } else if (room.players[room.gameState.currentPlayerIndex]?.id === socketId) {
          advanceTurnAfterFold(room);
        }
      }
      room.players.splice(playerIdx, 1);
      socketToRoom.delete(socketId);
      socketToPlayer.delete(socketId);
    }
  } else if (spectatorIdx !== -1) {
    playerName = room.spectators[spectatorIdx].name;
    room.spectators.splice(spectatorIdx, 1);
    socketToRoom.delete(socketId);
  }

  // If host left, reassign
  if (room.hostSocketId === socketId && room.players.length > 0) {
    const newHost = room.players.find(p=>!p.disconnected);
    if (newHost) {
      room.hostSocketId = newHost.id;
      emitLog(room, `👑 ${newHost.name} es el nuevo anfitrión.`, 'info');
    }
  }

  checkRoomEmpty(room);
  if (!rooms.has(room.id)) return;
  if (room.hasStarted) {
    const activeLeft = room.players.filter(p => !p.eliminated && !p.disconnected);
    if (activeLeft.length < MIN_PLAYERS) {
      const msg = activeLeft[0] ? `🏆 ${activeLeft[0].name} gana la partida. La sala se cerró.` : 'La partida terminó. La sala se cerró.';
      closeRoom(room, msg);
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
  if (active.length <= 1) {
    endHand(room);
    return;
  }

  gs.currentPlayerIndex = getNextActiveIndex(room, gs.currentPlayerIndex);
  while (room.players[gs.currentPlayerIndex]?.allIn) {
    const next = getNextActiveIndex(room, gs.currentPlayerIndex);
    if (next === gs.currentPlayerIndex) break;
    gs.currentPlayerIndex = next;
  }
  emitRoomState(room);
  startTurnTimer(room);
}

function checkRoomEmpty(room) {
  const total = room.players.length + room.spectators.length;
  if (total === 0) {
    clearTurnTimer(room);
    if (bannedPlayers.has(room.id)) bannedPlayers.delete(room.id);
    rooms.delete(room.id);
    broadcastRoomList();
  }
}

// ============================================================
// SOCKET HANDLERS
// ============================================================
io.on('connection', (socket) => {
  // Send initial room list
  socket.emit('roomList', getRoomList());

  // ---- CREATE ROOM ----
  socket.on('createRoom', (data) => {
    try {
      if (socketToRoom.has(socket.id)) return socket.emit('error', { msg: 'Ya estás en una sala.' });
      const name = sanitize(data.roomName) || 'Sala de Poker';
      const playerName = sanitize(data.playerName) || 'Host';
      const password = typeof data.password === 'string' ? data.password.slice(0,20) : '';
      const maxPlayers = data.maxPlayers;
      const startingStack = data.startingStack;

      const roomId = crypto.randomBytes(4).toString('hex');
      const room = createRoom(roomId, name, socket.id, playerName, password, maxPlayers, startingStack);
      const player = createPlayer(socket.id, playerName, room.startingStack);
      player.seatIndex = 0;
      room.players.push(player);

      rooms.set(roomId, room);
      socketToRoom.set(socket.id, roomId);
      socketToPlayer.set(socket.id, player);

      socket.join(roomId);
      socket.emit('roomJoined', { roomId, isHost: true });
      emitRoomState(room);
      broadcastRoomList();
      emitLog(room, `👑 ${playerName} creó la sala y es el anfitrión.`, 'info');
    } catch(e) { socket.emit('error', { msg: 'Error al crear sala.' }); }
  });

  // ---- JOIN ROOM ----
  socket.on('joinRoom', (data) => {
    try {
      if (socketToRoom.has(socket.id)) return socket.emit('error', { msg: 'Ya estás en una sala.' });

      const room = rooms.get(data.roomId);
      if (!room) return socket.emit('error', { msg: 'Sala no encontrada.' });

      // Check ban
      const playerName = sanitize(data.playerName) || 'Player';
      if (bannedPlayers.has(room.id) && bannedPlayers.get(room.id).has(playerName)) {
        return socket.emit('banned', { reason: 'Estás baneado de esta sala.' });
      }

      // Password check
      if (room.password && room.password !== data.password) {
        return socket.emit('error', { msg: 'Contraseña incorrecta.' });
      }

      // Check reconnect
      const disconnectedPlayer = room.players.find(p => p.name === playerName && p.disconnected);
      if (disconnectedPlayer) {
        const oldId = disconnectedPlayer.id;
        disconnectedPlayer.id = socket.id;
        disconnectedPlayer.disconnected = false;
        if (room.hostSocketId === oldId) room.hostSocketId = socket.id;
        socketToRoom.delete(oldId);
        socketToPlayer.delete(oldId);
        socketToRoom.set(socket.id, room.id);
        socketToPlayer.set(socket.id, disconnectedPlayer);
        socket.join(room.id);
        socket.emit('roomJoined', { roomId: room.id, isHost: room.hostSocketId === socket.id });
        emitLog(room, `📡 ${playerName} reconectado.`, 'info');
        emitRoomState(room);
        return;
      }

      const seatedPlayers = room.players.length;
      if (seatedPlayers >= room.maxPlayers && room.state === 'playing') {
        // Join as spectator
        room.spectators.push({ id: socket.id, name: playerName });
        socketToRoom.set(socket.id, room.id);
        socket.join(room.id);
        socket.emit('roomJoined', { roomId: room.id, isHost: false, isSpectator: true });
        emitLog(room, `👁️ ${playerName} se unió como espectador.`, 'info');
        emitRoomState(room);
        broadcastRoomList();
        return;
      }

      if (seatedPlayers >= room.maxPlayers) {
        return socket.emit('error', { msg: 'Sala llena.' });
      }

      const player = createPlayer(socket.id, playerName, room.startingStack);
      player.seatIndex = room.players.length;
      if (room.state === 'playing') {
        player.waitingNextHand = true;
        player.folded = true;
        player.cards = [];
      }
      room.players.push(player);
      socketToRoom.set(socket.id, room.id);
      socketToPlayer.set(socket.id, player);

      socket.join(room.id);
      socket.emit('roomJoined', { roomId: room.id, isHost: false });
      if (room.state === 'playing') {
        emitLog(room, `⏳ ${playerName} se unió y jugará desde la próxima mano.`, 'join');
      } else {
        emitLog(room, `✅ ${playerName} se unió a la sala.`, 'join');
      }
      emitRoomState(room);
      broadcastRoomList();
    } catch(e) { socket.emit('error', { msg: 'Error al unirse.' }); }
  });

  // ---- START GAME ----
  socket.on('startGame', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return socket.emit('error', { msg: 'Solo el anfitrión puede iniciar.' });
    if (room.state === 'playing') return socket.emit('error', { msg: 'Partida ya en curso.' });
    startGame(room);
  });

  // ---- GAME ACTION ----
  socket.on('action', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room || room.state !== 'playing') return;
    const action = data.action;
    const amount = parseInt(data.amount) || 0;
    if (!['fold','check','call','raise','allin'].includes(action)) return;
    handleAction(room, socket.id, action, amount);
  });

  // ---- CHAT ----
  socket.on('chatMessage', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    const text = sanitize(typeof data.text === 'string' ? data.text : '');
    if (!text || text.length === 0) return;
    const player = room.players.find(p=>p.id===socket.id) || room.spectators.find(s=>s.id===socket.id);
    if (!player) return;
    io.to(room.id).emit('chatMessage', { name: player.name, text: text.slice(0,200), ts: Date.now() });
  });

  // ---- REVIVE ----
  socket.on('requestRevive', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    requestRevive(room, socket.id);
  });

  socket.on('voteRevive', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    voteRevive(room, socket.id, !!data.vote);
  });

  // ---- HOST ACTIONS ----
  socket.on('kickPlayer', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    kickPlayer(room, socket.id, data.targetId);
  });

  socket.on('banPlayer', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    banPlayer(room, socket.id, data.targetId);
  });

  socket.on('addChips', (data) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    addChips(room, socket.id, data.targetId, data.amount);
  });

  socket.on('restartGame', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    restartGame(room, socket.id);
  });

  socket.on('endGame', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    endGame(room, socket.id);
  });

  socket.on('leaveRoom', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    emitLog(room, `🚪 ${getPlayerName(socket.id, room)} abandonó la sala.`, 'leave');
    removePlayerFromRoom(room, socket.id, false);
    socket.leave(room.id);
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    removePlayerFromRoom(room, socket.id, true);
    socketToRoom.delete(socket.id);
    socketToPlayer.delete(socket.id);
  });

  // ---- REFRESH ROOMS ----
  socket.on('getRooms', () => {
    socket.emit('roomList', getRoomList());
  });
});

function getPlayerRoom(socketId) {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return null;
  return rooms.get(roomId) || null;
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
  console.log(`🃏 Poker Online Server running on port ${PORT}`);
  console.log(`   → http://localhost:${PORT}`);
});
