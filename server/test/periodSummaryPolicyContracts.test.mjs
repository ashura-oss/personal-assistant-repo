import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalBackgroundJson } from '../dist/backgroundContracts.js';
import { parsePeriodSummaryPolicy, assertPeriodSummaryOptionsRevision } from '../dist/periodSummaryPolicyContracts.js';

const paidConsent = { authorized: true, model: 'openai/gpt-6-luna:batch', effort: 'low' };
const sources = { notes:true,chat:false,tasks:true,decisions:false,acceptedInferences:false,mailAccounts:[],calendarAccounts:[],documentPaths:[],knowledge:[] };
function legacy(overrides={}) { return { kind:'period_summary',period:'daily',timeZone:'UTC',sources,instructions:'Keep it brief',catchUp:'ask',paidConsent,...overrides }; }
function v2(overrides={}) { return { ...legacy(),version:2,localDeliveryTime:'08:30',executionOptions:{version:2,emailText:{mode:'complete_body'},application:{mode:'review'}},...overrides }; }

test('legacy parsing keeps its exact legacy fields and digest projection without injected V2 defaults',()=>{
  const raw=legacy();
  const parsed=parsePeriodSummaryPolicy(raw);
  assert.equal(parsed.version,1);
  assert.equal(Object.hasOwn(parsed.specification,'localDeliveryTime'),false);
  assert.equal(Object.hasOwn(parsed.specification,'executionOptions'),false);
  assert.equal(Object.hasOwn(JSON.parse(parsed.canonicalJson),'version'),false);
  assert.equal(Object.hasOwn(JSON.parse(parsed.canonicalJson),'executionOptions'),false);
  assert.equal(parsed.canonicalJson,canonicalBackgroundJson(raw));
  assert.equal(parsed.digest,createHash('sha256').update(parsed.canonicalJson).digest('hex'));
  assert.deepEqual(parsed.executionOptions,{version:1,emailText:{mode:'complete_body'},application:{mode:'review'}});
});

test('V2 requires closed separately versioned email and application consents',()=>{
  const parsed=parsePeriodSummaryPolicy(v2({executionOptions:{version:2,
    emailText:{mode:'available_extracted_email_text',consentVersion:1},application:{mode:'automatic',consentVersion:1}}}));
  assert.equal(parsed.version,2);
  assert.equal(parsed.executionOptions.emailText.mode,'available_extracted_email_text');
  assert.equal(parsed.executionOptions.application.mode,'automatic');
  for(const bad of [
    {version:2,emailText:{mode:'available_extracted_email_text'},application:{mode:'review'}},
    {version:2,emailText:{mode:'complete_body',consentVersion:1},application:{mode:'review'}},
    {version:2,emailText:{mode:'complete_body'},application:{mode:'automatic'}},
    {version:2,emailText:{mode:'complete_body'},application:{mode:'review',consentVersion:1}},
    {version:2,emailText:{mode:'complete_body'},application:{mode:'review'},silentUpgrade:true},
  ]) assert.throws(()=>parsePeriodSummaryPolicy(v2({executionOptions:bad})),/period_summary_policy_invalid|background_policy_invalid/);
});

test('V2 canonical digest binds the explicit execution options and never accepts unknown versions',()=>{
  const review=parsePeriodSummaryPolicy(v2());
  const automatic=parsePeriodSummaryPolicy(v2({executionOptions:{version:2,emailText:{mode:'complete_body'},application:{mode:'automatic',consentVersion:1}}}));
  assert.notEqual(review.digest,automatic.digest);
  assert.equal(JSON.parse(review.canonicalJson).executionOptions.application.mode,'review');
  assert.throws(()=>parsePeriodSummaryPolicy(v2({version:3})),/period_summary_policy_invalid/);
  assert.throws(()=>parsePeriodSummaryPolicy(v2({paidConsent:{...paidConsent,effort:'medium'}})),/background_policy_invalid/);
});

test('changing execution consent requires a higher policy revision',()=>{
  const old=parsePeriodSummaryPolicy(legacy());
  const next=parsePeriodSummaryPolicy(v2({executionOptions:{version:2,emailText:{mode:'complete_body'},application:{mode:'automatic',consentVersion:1}}}));
  assert.throws(()=>assertPeriodSummaryOptionsRevision(old,next,4,4),/period_summary_policy_invalid/);
  assert.doesNotThrow(()=>assertPeriodSummaryOptionsRevision(old,next,4,5));
  assert.doesNotThrow(()=>assertPeriodSummaryOptionsRevision(old,parsePeriodSummaryPolicy(legacy({instructions:'changed'})),4,4));
});
