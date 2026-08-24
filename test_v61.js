'use strict';
const assert = require('assert');
const E = require('./server');

function mkRoom(n=3){
  const r=E.createRoom('v61','test','p0','P0','',7,1000,'texas');
  for(let i=0;i<n;i++){
    const p=E.createPlayer('p'+i,'P'+i,1000,{},'secret-token-'+i);
    p.seatIndex=i; r.players.push(p);
  }
  r.hostSocketId='p0'; r.hasStarted=true; r.state='playing'; r.gameState=E.createGameState(r);
  E.rooms.set(r.id,r);
  return r;
}

// side pots exposed to clients must be plain serializable data and must not leak player/session objects.
{
  const r=mkRoom(3), g=r.gameState;
  r.players[0].totalBet=100; r.players[1].totalBet=300; r.players[2].totalBet=300;
  g.sidePots=E.calculateSidePots(r);
  r.players[1]._removalTimer=setTimeout(()=>{},60000); // would make raw player objects circular/non-serializable
  const state=E.buildGameStateFor(r,'p0');
  const json=JSON.stringify(state);
  assert(!json.includes('secret-token'), 'sessionToken leaked through gameState');
  assert.deepStrictEqual(state.gameState.sidePots.map(x=>x.eligibleIds.length), [3,2]);
  assert(!('eligible' in state.gameState.sidePots[0]), 'raw player objects leaked in side pots');
  clearTimeout(r.players[1]._removalTimer); r.players[1]._removalTimer=null;
  E.rooms.delete(r.id);
}

// stack=0 while still all-in is ALL-IN, not OUT/busted.
{
  const r=mkRoom(2); const p=r.players[0];
  p.stack=0; p.allIn=true; p.eliminated=false;
  const state=E.buildGameStateFor(r,'p0');
  assert.strictEqual(state.players[0].status,'allin');
  E.rooms.delete(r.id);
}

// Invalid action must not reset/replace the current turn timer.
{
  const r=mkRoom(2), g=r.gameState;
  g.phase='preflop'; g.currentPlayerIndex=0; g.currentBet=100; g.minRaise=100;
  r.players[0].bet=0; r.players[0].actedThisRound=false;
  r.players[1].bet=100; r.players[1].actedThisRound=true;
  const timer=setTimeout(()=>{},60000); g.turnTimer=timer;
  E.handleAction(r,'p0','check',0);
  assert.strictEqual(g.turnTimer,timer,'invalid action reset the timer');
  clearTimeout(timer); g.turnTimer=null; E.rooms.delete(r.id);
}

// Disconnecting a NON-current player must not change current actor or replace their timer.
{
  const r=mkRoom(3), g=r.gameState;
  g.phase='flop'; g.currentBet=0; g.currentPlayerIndex=1;
  for(const p of r.players){p.folded=false;p.allIn=false;p.eliminated=false;p.disconnected=false;p.waitingNextHand=false;p.actedThisRound=false;p.bet=0;}
  const timer=setTimeout(()=>{},60000); g.turnTimer=timer;
  E.removePlayerFromRoom(r,'p2',true);
  assert.strictEqual(g.currentPlayerIndex,1,'non-current disconnect changed the actor');
  assert.strictEqual(g.turnTimer,timer,'non-current disconnect reset current player timer');
  assert.strictEqual(r.players[2].disconnected,true);
  clearTimeout(timer); g.turnTimer=null;
  if(r.players[2]._removalTimer) clearTimeout(r.players[2]._removalTimer);
  E.rooms.delete(r.id);
}

console.log('V6.1 regression tests: OK');
process.exit(0);
