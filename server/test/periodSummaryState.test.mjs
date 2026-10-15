import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { findLatestDuePeriodStart, firstPeriodAtOrAfterActivation, planDuePeriodSummarySlots, PeriodSummaryState } from '../dist/periodSummaryState.js';

function setup() {
  const directory=mkdtempSync(join(tmpdir(),'still-period-summary-state-'));
  const kernel=createDurableKernel({databasePath:join(directory,'workspace.sqlite'),validateSnapshot:(value)=>assert.ok(value&&typeof value==='object'&&!Array.isArray(value))});
  const ownerId=randomUUID();const workspace=kernel.createWorkspace(ownerId,{accounts:[],documents:[]});
  const sessionToken=kernel.createSession(workspace.workspaceId,ownerId,Date.now()+60*60_000);
  return {directory,kernel,ownerId,workspace,sessionToken,state:new PeriodSummaryState(kernel,sessionToken)};
}
function close(f){f.kernel.close();rmSync(f.directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
function tx(f,fn){return f.kernel.withOwnedTransaction(f.sessionToken,0,fn);}
function activation(f,period='daily',timeZone='UTC',activationAt='2026-10-15T12:00:00.000Z',policyId=randomUUID()){
  return tx(f,(context)=>f.state.beginActivation(context,{policyId,policyRevision:1,period,timeZone,localDeliveryTime:'08:00',catchUp:'all',activationAt}));
}

test('activation boundary uses complete-period clock for all four periods and DST transitions',()=>{
  const at='2026-03-08T15:00:00.000Z';
  const expected={daily:'2026-03-09',weekly:'2026-03-09',monthly:'2026-04-01',yearly:'2027-01-01'};
  for(const period of Object.keys(expected)) assert.equal(firstPeriodAtOrAfterActivation({period,timeZone:'America/Toronto',localDeliveryTime:'08:00',activationAt:at}).localPeriod,expected[period]);
  const skipped=firstPeriodAtOrAfterActivation({period:'daily',timeZone:'Pacific/Apia',localDeliveryTime:'08:00',activationAt:'2011-12-30T09:00:00.000Z'});
  assert.equal(skipped.localPeriod,'2011-12-30');assert.equal(skipped.empty,true);
});

test('catch-up modes preserve every due period and distinguish review from suppression',()=>{
  const base={period:'daily',timeZone:'UTC',localDeliveryTime:'08:00',firstLocalPeriod:'2026-10-14',throughUtc:'2026-10-17T09:00:00.000Z'};
  const all=planDuePeriodSummarySlots({...base,catchUp:'all'}).periods;
  const latest=planDuePeriodSummarySlots({...base,catchUp:'latest'}).periods;
  const ask=planDuePeriodSummarySlots({...base,catchUp:'ask'}).periods;
  assert.deepEqual(all.map((item)=>item.status),['eligible','eligible','eligible']);
  assert.deepEqual(latest.map((item)=>item.status),['suppressed','suppressed','eligible']);
  assert.deepEqual(latest.slice(0,2).map((item)=>item.reason),['catch_up_latest','catch_up_latest']);
  assert.deepEqual(ask.map((item)=>item.status),['awaiting_review','awaiting_review','eligible']);
});

test('latest due lookup examines only nearby civil periods even with a century of backlog',()=>{
  const latest=findLatestDuePeriodStart({period:'daily',timeZone:'UTC',localDeliveryTime:'08:00',
    firstLocalPeriod:'1900-01-01',throughUtc:'2026-10-17T09:00:00.000Z'});
  assert.equal(latest.localPeriod,'2026-10-16');
  assert.ok(latest.examinedPeriods<=3,`examined ${latest.examinedPeriods} periods`);
  const apia=findLatestDuePeriodStart({period:'daily',timeZone:'Pacific/Apia',localDeliveryTime:'08:00',
    firstLocalPeriod:'2011-12-29',throughUtc:'2011-12-30T20:00:00.000Z'});
  assert.equal(apia.localPeriod,'2011-12-29');
  assert.ok(apia.examinedPeriods<=3);
});

test('latest and ask catch-up decisions remain global across multiple durable cursor pages',()=>{
  const base={period:'daily',timeZone:'UTC',localDeliveryTime:'08:00',firstLocalPeriod:'2026-01-01',throughUtc:'2026-09-15T09:00:00.000Z',pageSize:50};
  for(const [catchUp,olderStatus] of [['latest','suppressed'],['ask','awaiting_review'],['all','eligible']]){
    let cursor;let count=0;let eligible=0;const statuses=[];
    do{
      const page=planDuePeriodSummarySlots({...base,catchUp,...(cursor?{cursor}:{})});
      count+=page.periods.length;
      for(const item of page.periods){
        statuses.push(item.status);
        if(item.status==='eligible')eligible+=1;
      }
      cursor=page.nextCursor;
    }while(cursor);
    assert.ok(count>200);
    if(catchUp==='all')assert.equal(eligible,count);
    else{
      assert.equal(eligible,1);
      assert.ok(statuses.slice(0,-1).every((status)=>status===olderStatus));
      assert.equal(statuses.at(-1),'eligible');
    }
  }
});

test('paused periods are not backfilled implicitly; resume receives a fresh later boundary',()=>{
  const f=setup();try{
    const first=activation(f);
    tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,first,[{localPeriodStart:first.firstLocalPeriod,status:'eligible',reason:null}]));
    tx(f,(context)=>f.state.pauseActivationWithinTransaction(context,first));
    const second=activation(f,'daily','UTC','2026-10-20T12:00:00.000Z');
    assert.notEqual(second.activationId,first.activationId);
    assert.equal(second.firstLocalPeriod,'2026-10-21');
    assert.deepEqual(tx(f,(context)=>f.state.getSlotsWithinTransaction(context,'daily',null,10)).map((slot)=>slot.localPeriodStart),[first.firstLocalPeriod]);
    const slots=tx(f,(context)=>f.state.getSlotsWithinTransaction(context,'daily',null,10));
    assert.equal(slots[0].status,'awaiting_review');
    assert.equal(slots[0].reason,'policy_paused_before_dispatch');
  }finally{close(f);}
});

test('global slot uniqueness spans policy ids and linked slots survive state-object restart',()=>{
  const f=setup();try{
    const first=activation(f);
    tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,first,[{localPeriodStart:first.firstLocalPeriod,status:'eligible',reason:null}]));
    tx(f,(context)=>f.state.pauseActivationWithinTransaction(context,first));
    const resumed=activation(f,'daily','UTC','2026-10-15T12:00:00.000Z');
    assert.notEqual(resumed.policyId,first.policyId);
    assert.equal(resumed.firstLocalPeriod,first.firstLocalPeriod);
    tx(f,(context)=>assert.throws(()=>f.state.materializeDueSlotsWithinTransaction(context,resumed,[{localPeriodStart:resumed.firstLocalPeriod,status:'eligible',reason:null}]),/period_summary_global_slot_conflict/));
    const newState=new PeriodSummaryState(f.kernel,f.sessionToken);
    const slots=tx(f,(context)=>newState.getSlotsWithinTransaction(context,'daily',null,10));
    assert.equal(slots.length,1);
    assert.equal(slots[0].status,'awaiting_review');
  }finally{close(f);}
});

test('policy revision preserves activation but parks unsubmitted eligible work for explicit review',()=>{
  const f=setup();try{
    const first=activation(f);
    tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,first,[{localPeriodStart:first.firstLocalPeriod,status:'eligible',reason:null}]));
    const revised=tx(f,(context)=>f.state.revisePolicyWithinTransaction(context,first,2));
    assert.equal(revised.activationId,first.activationId);assert.equal(revised.firstLocalPeriod,first.firstLocalPeriod);
    const slot=tx(f,(context)=>f.state.getSlotsWithinTransaction(context,'daily',null,1)[0]);
    assert.equal(slot.status,'awaiting_review');assert.equal(slot.reason,'policy_revision_changed');
    assert.throws(()=>tx(f,(context)=>f.state.linkSlotWithinTransaction(context,'daily',first.firstLocalPeriod,randomUUID(),'e'.repeat(64))),/period_summary_slot_stale/);
  }finally{close(f);}
});

test('materialization cursor is oldest-first, replay-safe, and activation proof fields cannot be substituted',()=>{
  const f=setup();try{
    const active=activation(f);
    const start=active.firstLocalPeriod;
    const second=new Date(Date.parse(`${start}T00:00:00.000Z`)+86400_000).toISOString().slice(0,10);
    const decisions=[{localPeriodStart:start,status:'eligible',reason:null},{localPeriodStart:second,status:'suppressed',reason:'catch_up_latest'}];
    tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,active,decisions));
    assert.equal(tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,active,decisions)).length,2);
    const forged={...active,timeZone:'Pacific/Auckland'};
    assert.throws(()=>tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,forged,decisions)),/period_summary_activation_stale/);
    const skipped=new Date(Date.parse(`${second}T00:00:00.000Z`)+2*86400_000).toISOString().slice(0,10);
    assert.throws(()=>tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,active,[{localPeriodStart:skipped,status:'eligible',reason:null}])),/period_summary_materialization_cursor_gap/);
    assert.equal(tx(f,(context)=>f.state.getSlotsWithinTransaction(context,'daily',null,10)).length,2);
  }finally{close(f);}
});

test('slot materialization rolls back atomically and requires exact owned context and identity',()=>{
  const f=setup();const other=setup();try{
    const active=activation(f);
    assert.throws(()=>tx(other,(context)=>f.state.beginActivation(context,{policyId:randomUUID(),policyRevision:1,period:'daily',timeZone:'UTC',localDeliveryTime:'08:00',catchUp:'all',activationAt:'2026-10-15T12:00:00.000Z'})),(error)=>error?.code==='transaction_context_expired');
    assert.throws(()=>tx(f,(context)=>{f.state.materializeDueSlotsWithinTransaction(context,active,[{localPeriodStart:active.firstLocalPeriod,status:'eligible',reason:null}]);throw new Error('rollback');}),/rollback/);
    assert.deepEqual(tx(f,(context)=>f.state.getSlotsWithinTransaction(context,'daily',null,10)),[]);
  }finally{close(other);close(f);}
});

test('durable linked and ambiguous decisions cannot be rearmed by ordinary state transitions',()=>{
  const f=setup();try{
    const active=activation(f);
    const start=active.firstLocalPeriod;
    tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,active,[{localPeriodStart:start,status:'eligible',reason:null}]));
    const linked=tx(f,(context)=>f.state.linkSlotWithinTransaction(context,'daily',start,randomUUID(),'a'.repeat(64)));
    assert.equal(linked.status,'linked');
    assert.throws(()=>tx(f,(context)=>f.state.deferSlotWithinTransaction(context,'daily',start,'linked','source_changed','b'.repeat(64))),/period_summary_slot_stale/);
    const next=new Date(Date.parse(`${start}T00:00:00.000Z`)+86400_000).toISOString().slice(0,10);
    tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,active,[{localPeriodStart:next,status:'eligible',reason:null}]));
    const ambiguous=tx(f,(context)=>f.state.markSlotAmbiguousWithinTransaction(context,'daily',next,'eligible','c'.repeat(64)));
    assert.equal(ambiguous.status,'ambiguous');
    assert.throws(()=>tx(f,(context)=>f.state.linkSlotWithinTransaction(context,'daily',next,randomUUID(),'d'.repeat(64))),/period_summary_slot_stale/);
  }finally{close(f);}
});

test('only current active eligible slots can become linked; review, suppressed, deferred, and paused work cannot',()=>{
  const f=setup();try{
    const active=activation(f);
    const starts=[active.firstLocalPeriod];
    for(let index=1;index<4;index+=1){
      starts.push(new Date(Date.parse(`${starts.at(-1)}T00:00:00.000Z`)+86400_000).toISOString().slice(0,10));
    }
    tx(f,(context)=>f.state.materializeDueSlotsWithinTransaction(context,active,[
      {localPeriodStart:starts[0],status:'eligible',reason:null},
      {localPeriodStart:starts[1],status:'suppressed',reason:'catch_up_latest'},
      {localPeriodStart:starts[2],status:'eligible',reason:null},
      {localPeriodStart:starts[3],status:'eligible',reason:null},
    ]));
    assert.throws(()=>tx(f,(context)=>f.state.linkSlotWithinTransaction(context,'daily',starts[1],randomUUID(),'f'.repeat(64))),/period_summary_slot_stale/);
    tx(f,(context)=>f.state.deferSlotWithinTransaction(context,'daily',starts[2],'eligible','source_changed','1'.repeat(64)));
    assert.throws(()=>tx(f,(context)=>f.state.linkSlotWithinTransaction(context,'daily',starts[2],randomUUID(),'2'.repeat(64))),/period_summary_slot_stale/);
    tx(f,(context)=>f.state.pauseActivationWithinTransaction(context,active));
    assert.throws(()=>tx(f,(context)=>f.state.linkSlotWithinTransaction(context,'daily',starts[0],randomUUID(),'3'.repeat(64))),/period_summary_slot_stale/);
  }finally{close(f);}
});

test('private schema rejects future versions and missing indexes instead of silently repairing them',()=>{
  const f=setup();try{
    tx(f,(context)=>f.state.beginActivation(context,{policyId:randomUUID(),policyRevision:1,period:'daily',timeZone:'UTC',localDeliveryTime:'08:00',catchUp:'all',activationAt:'2026-10-15T12:00:00.000Z'}));
    f.kernel.withTrustedDatabaseTransaction((db)=>db.prepare('UPDATE period_summary_state_schema SET version=2 WHERE singleton=1').run());
    assert.throws(()=>new PeriodSummaryState(f.kernel,f.sessionToken),/period_summary_state_schema_unsupported/);
  }finally{close(f);}
  const second=setup();try{
    second.kernel.withTrustedDatabaseTransaction((db)=>db.exec('DROP INDEX period_summary_activation_due'));
    assert.throws(()=>new PeriodSummaryState(second.kernel,second.sessionToken),/period_summary_state_schema_invalid:indexes/);
  }finally{close(second);}
});
