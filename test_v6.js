'use strict';
const assert = require('assert');
const E = require('./server.js');

let seq = 0;
function makeRoom(n, mode='texas', stacks=null) {
  const id='test'+(++seq);
  const room=E.createRoom(id,'Test','p0','P0','',Math.max(n,2),5000,mode);
  room.settings.turnTimeout=300000;
  room.settings.allowRevive=false;
  for(let i=0;i<n;i++) {
    const p=E.createPlayer('p'+i,'P'+i,stacks?stacks[i]:5000,{},'tok'+i);
    p.seatIndex=i; room.players.push(p);
  }
  room.hostSocketId='p0';
  E.rooms.set(id,room);
  E.startGame(room);
  return room;
}
function act(room, id, action, amount=0){
  const p=room.players.find(x=>x.id===id); if(p) p.lastAction=0;
  const ok=E.handleAction(room,id,action,amount);
  assert.strictEqual(ok,true,`action failed ${id} ${action}`);
}
function validCard(c){ return typeof c==='string' && /^[2-9TJQKA][shdc]$/.test(c); }

// 1. Dealer rotates exactly once per new hand.
{
  const r=makeRoom(4);
  const ds=[r.gameState.dealerIndex];
  for(let i=0;i<3;i++){ E.startNewHand(r); ds.push(r.gameState.dealerIndex); }
  assert.deepStrictEqual(ds,[0,1,2,3], 'dealer rotation');
}

// 2. BB retains option after everyone merely calls (3-handed).
{
  const r=makeRoom(3);
  assert.strictEqual(r.gameState.currentPlayerIndex,0);
  act(r,'p0','call');
  act(r,'p1','call');
  assert.strictEqual(r.gameState.currentPlayerIndex,2,'BB must act');
  assert.strictEqual(r.gameState.phase,'preflop');
  act(r,'p2','check');
  assert.strictEqual(r.gameState.phase,'flop');
}

// 3. Heads-up: dealer/SB acts first preflop; BB still has check option.
{
  const r=makeRoom(2);
  assert.strictEqual(r.gameState.dealerIndex,0);
  assert.strictEqual(r.gameState.smallBlindIndex,0);
  assert.strictEqual(r.gameState.bigBlindIndex,1);
  assert.strictEqual(r.gameState.currentPlayerIndex,0);
  act(r,'p0','call');
  assert.strictEqual(r.gameState.currentPlayerIndex,1);
  act(r,'p1','check');
  assert.strictEqual(r.gameState.phase,'flop');
}

// 4. One short all-in does NOT reopen raise rights for a player who already acted.
{
  const r=makeRoom(3,'texas',[1000,250,1000]);
  act(r,'p0','call');       // acted facing 200
  act(r,'p1','allin');      // SB: 100 + 150 => 250, raise only 50
  act(r,'p2','call');       // BB calls extra 50
  assert.strictEqual(r.gameState.currentPlayerIndex,0);
  assert.strictEqual(E.canPlayerRaise(r,r.players[0]),false,'short raise reopened action incorrectly');
  act(r,'p0','call');
  assert.strictEqual(r.gameState.phase,'flop');
}

// 5. Cumulative short all-ins can reopen action once total faced reaches a full raise.
{
  const r=makeRoom(4,'texas',[1000,250,400,1000]);
  // dealer p0, SB p1, BB p2, UTG p3
  act(r,'p3','call');
  act(r,'p0','call');
  act(r,'p1','allin');      // to 250 (+50)
  act(r,'p2','allin');      // to 400 (+150), still short individually
  assert.strictEqual(r.gameState.currentPlayerIndex,3);
  assert.strictEqual(E.canPlayerRaise(r,r.players[3]),true,'cumulative short raises should reopen');
}

// 6. Side pots preserve all committed chips, including folded contributions.
{
  const r=makeRoom(4);
  r.players[0].totalBet=100;
  r.players[1].totalBet=300;
  r.players[2].totalBet=500;
  r.players[3].totalBet=500; r.players[3].folded=true;
  r.gameState.pot=1400;
  const pots=E.calculateSidePots(r);
  assert.strictEqual(pots.reduce((s,p)=>s+p.amount,0),1400);
  assert.deepStrictEqual(pots.map(p=>p.amount),[400,600,400]);
}

// 7. Classic: 7 players can all exchange 5 without undefined cards or duplicate indices exhausting deck.
{
  const r=makeRoom(7,'classic');
  r.settings.maxCardsChange=5;
  // Bypass first betting round only for deck stress test.
  r.gameState.phase='exchange';
  r.gameState.exchangeOrder=[0,1,2,3,4,5,6];
  r.gameState.exchangeIndex=0;
  r.players.forEach(p=>{p.hasExchanged=false; p.folded=false; p.allIn=false;});
  for(let i=0;i<7;i++) {
    const ok=E.handleExchangeAction(r,'p'+i,'exchange',[0,1,2,3,4]);
    assert.strictEqual(ok,true,'classic exchange failed p'+i);
  }
  const cards=r.players.flatMap(p=>p.cards);
  assert.strictEqual(cards.length,35);
  assert(cards.every(validCard),'undefined/invalid card after reshuffle');
  assert.strictEqual(new Set(cards).size,35,'duplicate live cards after reshuffle');
}

// 8. Classic duplicate indices are de-duplicated (consume/replace only one position).
{
  const r=makeRoom(2,'classic');
  r.settings.maxCardsChange=5;
  r.gameState.phase='exchange'; r.gameState.exchangeOrder=[0,1]; r.gameState.exchangeIndex=0;
  const before=r.gameState.deck.length;
  const old=r.players[0].cards.slice();
  E.handleExchangeAction(r,'p0','exchange',[0,0,0,0,0]);
  assert.strictEqual(r.gameState.deck.length,before-1);
  assert.notStrictEqual(r.players[0].cards[0],old[0]);
  assert.deepStrictEqual(r.players[0].cards.slice(1),old.slice(1));
}

console.log('V6 tests: OK');
for (const r of E.rooms.values()) {
  if (r.gameState?.turnTimer) clearTimeout(r.gameState.turnTimer);
  if (r.gameState?.nextHandTimer) clearTimeout(r.gameState.nextHandTimer);
}
E.server.close(()=>{});
setTimeout(()=>process.exit(0),20);
