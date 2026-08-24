'use strict';
const assert=require('assert');
const E=require('./server.js');
let rid=0;
function rand(n){return Math.floor(Math.random()*n)}
function liveCount(r){return r.players.filter(p=>!p.eliminated&&!p.left&&!p.disconnected&&p.stack>0).length}
function cleanup(r){if(r.gameState?.turnTimer){clearTimeout(r.gameState.turnTimer);r.gameState.turnTimer=null}if(r.gameState?.nextHandTimer){clearTimeout(r.gameState.nextHandTimer);r.gameState.nextHandTimer=null}}
function make(n,mode){const id='f'+(++rid); const r=E.createRoom(id,'F','p0','P0','',n,4000,mode);r.settings.allowRevive=false;r.settings.turnTimeout=300000;r.settings.maxCardsChange=5;for(let i=0;i<n;i++){const p=E.createPlayer('p'+i,'P'+i,4000,{},'z'+rid+'_'+i);p.seatIndex=i;r.players.push(p)}r.hostSocketId='p0';E.rooms.set(id,r);E.startGame(r);cleanup(r);return r}
function chooseAction(r,p){const g=r.gameState; const call=Math.max(0,g.currentBet-p.bet); const canRaise=E.canPlayerRaise(r,p); const min=g.minRaise; const roll=rand(100);
  if(call===0){
    if(canRaise && p.stack>=min && roll<22){ const maxExtra=p.stack; const amt=Math.min(maxExtra, min*(1+rand(3))); return ['raise',amt]; }
    if(roll<28 && p.stack>0) return ['allin',0];
    return ['check',0];
  }
  if(roll<16) return ['fold',0];
  if(canRaise && p.stack>=call+min && roll<34){ const maxRaise=p.stack-call; const amt=Math.min(maxRaise,min*(1+rand(3))); return ['raise',amt]; }
  if(roll<43 && (canRaise || p.stack<=call)) return ['allin',0];
  return ['call',0];
}
function uniqueLiveCards(r){const cards=[];for(const p of r.players){for(const c of p.cards||[]){if(typeof c==='string'&&c!=='back')cards.push(c)}} for(const c of r.gameState.communityCards||[])cards.push(c); return new Set(cards).size===cards.length}
function playHand(r,total){let steps=0;while(r.gameState.phase!=='showdown' && steps++<250){cleanup(r);const g=r.gameState;
    if(r.gameMode==='classic' && g.phase==='exchange'){
      const idx=g.exchangeOrder[g.exchangeIndex]; const p=r.players[idx]; if(!p){throw new Error('bad exchange index')}
      const count=rand((r.settings.maxCardsChange??3)+1); const inds=[0,1,2,3,4].sort(()=>Math.random()-.5).slice(0,count);
      const ok=E.handleExchangeAction(r,p.id,'exchange',inds);assert(ok,'exchange rejected');cleanup(r);assert(uniqueLiveCards(r),'duplicate live card in classic');continue;
    }
    const p=r.players[g.currentPlayerIndex];
    if(!p || p.folded || p.allIn || p.disconnected || p.eliminated){ E.advancePhase(r); cleanup(r); continue; }
    p.lastAction=0; const [a,amt]=chooseAction(r,p); const ok=E.handleAction(r,p.id,a,amt); if(!ok){throw new Error(`rejected legal-ish ${a} phase=${g.phase} p=${p.id} call=${g.currentBet-p.bet} stack=${p.stack} min=${g.minRaise}`)}
    cleanup(r);
    const chipSum=r.players.reduce((s,x)=>s+x.stack,0)+r.gameState.pot;
    assert.strictEqual(chipSum,total,'chips not conserved during hand');
    assert(uniqueLiveCards(r),'duplicate live cards');
  }
  if(steps>=250) throw new Error('hand stuck');
  cleanup(r); assert.strictEqual(r.gameState.pot,0,'pot not cleared showdown');
  assert.strictEqual(r.players.reduce((s,x)=>s+x.stack,0),total,'chips not conserved after showdown');
}
for(const mode of ['texas','classic']){
  for(let n=2;n<=7;n++){
    for(let trial=0;trial<20;trial++){
      const r=make(n,mode);const total=n*4000;
      let hands=0;
      while(liveCount(r)>=2 && hands++<12){playHand(r,total);if(liveCount(r)>=2){E.startNewHand(r);cleanup(r)}}
    }
  }
  console.log(mode,'fuzz OK');
}
console.log('V6 fuzz: OK');
process.exit(0);
