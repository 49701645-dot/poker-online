const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
// Servimos la carpeta public donde estará el index.html
app.use(express.static(path.join(__dirname, 'public')));

// --- LÓGICA DE POKER ---
const SUITS = { 'S': {char: '♠', color: 'black'}, 'H': {char: '♥', color: 'red'}, 'D': {char: '♦', color: 'red'}, 'C': {char: '♣', color: 'black'} };
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RANK_VALUES = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14};
const SB_VAL = 100;
const BB_VAL = 200;

let rooms = {};

function createDeck() {
    let deck = [];
    for (let suit in SUITS) for (let rank of RANKS) deck.push({ rank, suit, value: RANK_VALUES[rank] });
    // Mezcla Fisher-Yates
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function evaluateHand(cards) {
    if (!cards || cards.length < 5) return { score: [0], name: "Desconocido" };
    let ranks = {}, suits = {};
    cards.forEach(c => { ranks[c.value] = (ranks[c.value] || 0) + 1; suits[c.suit] = (suits[c.suit] || 0) + 1; });
    
    let flushSuit = Object.keys(suits).find(s => suits[s] >= 5);
    let flushCards = flushSuit ? cards.filter(c => c.suit === flushSuit).sort((a,b)=>b.value-a.value) : null;
    
    let findSt = (arr) => {
        let vals = [...new Set(arr.map(c => c.value))].sort((a,b)=>b-a);
        if (vals.includes(14)) vals.push(1);
        for (let i = 0; i <= vals.length - 5; i++) if (vals[i] - vals[i+4] === 4) return vals[i];
        return null;
    };
    
    let stFlush = flushCards ? findSt(flushCards) : null;
    let st = findSt(cards);
    let groups = Object.entries(ranks).map(([v, c]) => ({val: parseInt(v), count: c})).sort((a,b) => b.count - a.count || b.val - a.val);
    let k = (excl, count) => cards.filter(c => !excl.includes(c.value)).sort((a,b)=>b.value-a.value).slice(0,count).map(c=>c.value);

    if (stFlush === 14) return { score: [10], name: "Escalera Real" };
    if (stFlush) return { score: [9, stFlush], name: "Escalera de Color" };
    if (groups[0].count === 4) return { score: [8, groups[0].val, k([groups[0].val], 1)[0]], name: "Poker" };
    if (groups[0].count === 3 && groups.length > 1 && groups[1].count >= 2) return { score: [7, groups[0].val, groups[1].val], name: "Full House" };
    if (flushCards) return { score: [6, ...flushCards.slice(0,5).map(c=>c.value)], name: "Color" };
    if (st) return { score: [5, st], name: "Escalera" };
    if (groups[0].count === 3) return { score: [4, groups[0].val, ...k([groups[0].val], 2)], name: "Trio" };
    if (groups[0].count === 2 && groups.length > 1 && groups[1].count === 2) return { score: [3, groups[0].val, groups[1].val, k([groups[0].val, groups[1].val], 1)[0]], name: "Doble Par" };
    if (groups[0].count === 2) return { score: [2, groups[0].val, ...k([groups[0].val], 3)], name: "Par" };
    return { score: [1, ...k([], 5)], name: "Carta Alta" };
}

function compareArrays(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        let vA = a[i] || 0, vB = b[i] || 0;
        if (vA !== vB) return vA - vB;
    }
    return 0;
}

// --- MÁQUINA DE ESTADO DE SALAS ---
function getRoomStateForPlayer(roomId, socketId) {
    let room = rooms[roomId];
    if (!room) return null;
    
    // Clonamos para no modificar la sala original al enviar datos
    let state = JSON.parse(JSON.stringify(room));
    delete state.deck; // NUNCA enviamos el mazo al cliente

    // Ocultar las cartas del rival (Seguridad del servidor)
    state.players.forEach(p => {
        if (p.id !== socketId && room.phaseIdx !== 4 && room.handActive) {
            p.cards = p.cards.map(() => ({ hidden: true })); 
        }
    });
    return state;
}

function broadcastState(roomId) {
    let room = rooms[roomId];
    if (!room) return;
    room.players.forEach(p => {
        io.to(p.id).emit('gameState', getRoomStateForPlayer(roomId, p.id));
    });
}

function logRoom(roomId, msg, type = '') {
    io.to(roomId).emit('gameLog', { msg, type });
}

function startHand(roomId) {
    let room = rooms[roomId];
    if (room.players.length !== 2) return;
    
    if (room.players[0].chips <= 0 || room.players[1].chips <= 0) {
        logRoom(roomId, "Juego Terminado. Alguien se quedó sin fichas.", "alert");
        return;
    }

    room.deck = createDeck();
    room.community = [];
    room.pot = 0;
    room.phaseIdx = 0;
    room.handActive = true;
    room.highestBet = 0;

    room.players.forEach(p => {
        p.cards = [room.deck.pop(), room.deck.pop()];
        p.bet = 0;
        p.acted = false;
        p.folded = false;
        p.allIn = (p.chips === 0);
    });

    room.dealerIdx = room.dealerIdx === 0 ? 1 : 0;
    const sbIdx = room.dealerIdx;
    const bbIdx = room.dealerIdx === 0 ? 1 : 0;

    logRoom(roomId, `--- NUEVA MANO ---`, 'alert');
    
    // Cobrar Ciegas
    let sbP = room.players[sbIdx];
    let bbP = room.players[bbIdx];
    
    let sbBet = Math.min(sbP.chips, SB_VAL);
    sbP.chips -= sbBet; sbP.bet += sbBet; room.pot += sbBet;
    if(sbP.chips === 0) sbP.allIn = true;

    let bbBet = Math.min(bbP.chips, BB_VAL);
    bbP.chips -= bbBet; bbP.bet += bbBet; room.pot += bbBet;
    if(bbP.chips === 0) bbP.allIn = true;

    room.highestBet = Math.max(sbP.bet, bbP.bet);
    room.minRaise = room.highestBet + BB_VAL;
    room.activeIdx = sbIdx; // En Heads-up, SB habla primero pre-flop

    broadcastState(roomId);
}

function handleRoundEnd(roomId) {
    let room = rooms[roomId];
    const p1 = room.players[0];
    const p2 = room.players[1];

    if (p1.folded || p2.folded) {
        room.handActive = false;
        const winner = p1.folded ? p2 : p1;
        winner.chips += room.pot;
        logRoom(roomId, `${winner.name} gana el pozo de ${room.pot} (Rival Foldeó)`, 'alert');
        broadcastState(roomId);
        setTimeout(() => startHand(roomId), 4000);
        return;
    }

    const betsMatched = p1.bet === p2.bet;
    const bothActed = p1.acted && p2.acted;
    const allInSettle = (p1.allIn && p2.acted && p2.bet >= p1.bet) || (p2.allIn && p1.acted && p1.bet >= p2.bet) || (p1.allIn && p2.allIn);

    if ((bothActed && betsMatched) || allInSettle) {
        room.phaseIdx++;
        room.players.forEach(p => { p.bet = 0; p.acted = false; });
        room.highestBet = 0;
        room.minRaise = BB_VAL;

        if (room.phaseIdx === 1) { // Flop
            room.deck.pop(); room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
            logRoom(roomId, `--- FLOP ---`, 'alert');
        } else if (room.phaseIdx === 2 || room.phaseIdx === 3) { // Turn / River
            room.deck.pop(); room.community.push(room.deck.pop());
            logRoom(roomId, room.phaseIdx === 2 ? `--- TURN ---` : `--- RIVER ---`, 'alert');
        }

        if (room.phaseIdx === 4) { // Showdown
            room.handActive = false;
            let res1 = evaluateHand([...p1.cards, ...room.community]);
            let res2 = evaluateHand([...p2.cards, ...room.community]);
            let cmp = compareArrays(res1.score, res2.score);
            
            if (cmp > 0) { p1.chips += room.pot; logRoom(roomId, `${p1.name} Gana con ${res1.name}`, 'alert'); }
            else if (cmp < 0) { p2.chips += room.pot; logRoom(roomId, `${p2.name} Gana con ${res2.name}`, 'alert'); }
            else { p1.chips += room.pot/2; p2.chips += room.pot/2; logRoom(roomId, `Empate con ${res1.name}`, 'alert'); }
            
            broadcastState(roomId);
            setTimeout(() => startHand(roomId), 6000);
            return;
        }

        // Post-flop: BB habla primero
        room.activeIdx = room.dealerIdx === 0 ? 1 : 0;
        // Si hay all-ins, saltamos fases automáticamente
        if (p1.allIn || p2.allIn) setTimeout(() => handleRoundEnd(roomId), 1500);
    } else {
        room.activeIdx = room.activeIdx === 0 ? 1 : 0;
    }
    broadcastState(roomId);
}

// --- MANEJO DE SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('createRoom', (playerName) => {
        const roomId = "POKER-" + Math.floor(1000 + Math.random() * 9000);
        rooms[roomId] = {
            id: roomId, deck: [], community: [], pot: 0, phaseIdx: 0, dealerIdx: 1, activeIdx: 0,
            highestBet: 0, minRaise: BB_VAL, handActive: false,
            players: [{ id: socket.id, name: playerName || "Jugador 1", chips: 5000, bet: 0, cards: [], acted: false, folded: false, allIn: false }]
        };
        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        broadcastState(roomId);
    });

    socket.on('joinRoom', ({roomId, playerName}) => {
        let room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', "La sala no existe.");
        if (room.players.length >= 2) return socket.emit('errorMsg', "La sala está llena.");
        
        room.players.push({ id: socket.id, name: playerName || "Jugador 2", chips: 5000, bet: 0, cards: [], acted: false, folded: false, allIn: false });
        socket.join(roomId);
        socket.emit('roomJoined', roomId);
        startHand(roomId); // Inicia el juego cuando entra el segundo
    });

    socket.on('chatMsg', ({roomId, msg}) => {
        let room = rooms[roomId];
        if(!room) return;
        let player = room.players.find(p => p.id === socket.id);
        io.to(roomId).emit('chatMsg', { sender: player ? player.name : 'Desc', msg });
    });

    socket.on('playerAction', ({roomId, action, amount}) => {
        let room = rooms[roomId];
        if (!room || !room.handActive) return;
        
        let pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex !== room.activeIdx) return; // Validación Anti-Trampas (Fuera de turno)
        
        let p = room.players[pIndex];
        let toCall = room.highestBet - p.bet;

        if (action === 'fold') {
            p.folded = true; logRoom(roomId, `${p.name} hace Fold`, 'action');
        } else if (action === 'call') {
            let actAmt = Math.min(p.chips, toCall);
            p.chips -= actAmt; p.bet += actAmt; room.pot += actAmt;
            if(p.chips === 0) p.allIn = true;
            logRoom(roomId, `${p.name} hace ${actAmt === 0 ? 'Check' : 'Call'}`, 'action');
        } else if (action === 'raise') {
            let raiseAmt = amount - p.bet;
            let actAmt = Math.min(p.chips, raiseAmt);
            p.chips -= actAmt; p.bet += actAmt; room.pot += actAmt;
            if(p.chips === 0) p.allIn = true;
            room.minRaise = amount + (amount - room.highestBet);
            room.highestBet = p.bet;
            room.players[pIndex === 0 ? 1 : 0].acted = false;
            logRoom(roomId, `${p.name} Sube a ${p.bet}`, 'action');
        } else if (action === 'allin') {
            let actAmt = p.chips;
            p.chips -= actAmt; p.bet += actAmt; room.pot += actAmt; p.allIn = true;
            if (p.bet > room.highestBet) {
                room.minRaise = p.bet + (p.bet - room.highestBet);
                room.highestBet = p.bet;
                room.players[pIndex === 0 ? 1 : 0].acted = false;
            }
            logRoom(roomId, `${p.name} va ALL-IN`, 'alert');
        }

        p.acted = true;
        handleRoundEnd(roomId);
    });

    socket.on('disconnect', () => {
        for(let rId in rooms) {
            let room = rooms[rId];
            if(room.players.some(p => p.id === socket.id)) {
                io.to(rId).emit('errorMsg', "El oponente se ha desconectado. Sala cerrada.");
                delete rooms[rId];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor de Poker corriendo en puerto ${PORT}`));