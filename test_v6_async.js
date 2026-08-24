'use strict';
const assert=require('assert');
const E=require('./server.js');
function room(n,mode,stacks){const id='async-'+mode;const r=E.createRoom(id,'T','p0','P0','',n,1000,mode);r.settings.allowRevive=false;r.settings.turnTimeout=300000;stacks.forEach((x,i)=>{const p=E.createPlayer('p'+i,'P'+i,x,{},'t'+i);p.seatIndex=i;r.players.push(p)});r.hostSocketId='p0';E.rooms.set(id,r);E.startGame(r);return r}
(async()=>{
  // both players forced all-in by blinds: board must run to showdown without an action/timer deadlock
  const t=room(2,'texas',[100,200]);
  assert.strictEqual(t.gameState.phase,'flop');
  await new Promise(r=>setTimeout(r,2800));
  assert.strictEqual(t.gameState.phase,'showdown','all-in board did not auto-run to showdown');

  // Classic all-in players must still receive the draw phase, then skip meaningless second betting round.
  const c=room(2,'classic',[100,200]);
  assert.strictEqual(c.gameState.phase,'exchange');
  const order=c.gameState.exchangeOrder.map(i=>c.players[i].id);
  assert.strictEqual(order.length,2);
  E.handleExchangeAction(c,order[0],'exchange',[]);
  E.handleExchangeAction(c,order[1],'exchange',[]);
  assert.strictEqual(c.gameState.phase,'showdown','classic all-in should reach showdown after draw');

  console.log('V6 async all-in tests: OK');
  for(const r of E.rooms.values()){if(r.gameState?.turnTimer)clearTimeout(r.gameState.turnTimer);if(r.gameState?.nextHandTimer)clearTimeout(r.gameState.nextHandTimer)}
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
