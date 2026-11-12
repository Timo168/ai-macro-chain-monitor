import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeProjectRecords} from '../lib/industry/project-merge.mjs';

test('baseline registry loaded last cannot erase source-adapter capacity or estimates',()=>{
 const official={id:'hyperion',status:'construction',powerCapacityMw:5000,capacityKind:'compute_capacity',lastVerifiedAt:'2026-11-12',sourceUrls:['https://meta.example/new'],capacityEvidence:[{id:'epoch',valueMw:1632,scope:'planned'}]};
 const baseline={id:'hyperion',owner:'Meta',powerCapacityMw:null,lastVerifiedAt:'2026-09-13',sourceUrls:['https://meta.example/old']};
 const [result]=mergeProjectRecords([{project:official,authoritative:true},{project:baseline}]);
 assert.equal(result.powerCapacityMw,5000);assert.equal(result.capacityKind,'compute_capacity');assert.equal(result.owner,'Meta');assert.equal(result.capacityEvidence[0].valueMw,1632);assert.equal(result.lastVerifiedAt,'2026-11-12');assert.equal(result.sourceUrls.length,2);
});
test('an operational transition with no official MW does not revive old planned capacity',()=>{
 const baseline={id:'temple',status:'construction',powerCapacityMw:1000,lastVerifiedAt:'2025-01-01'};
 const current={id:'temple',status:'operational',powerCapacityMw:null,lastVerifiedAt:'2026-11-12',capacityEvidence:[{id:'epoch',valueMw:178,scope:'current'}]};
 const [result]=mergeProjectRecords([{project:current,authoritative:true},{project:baseline}]);
 assert.equal(result.status,'operational');assert.equal(result.powerCapacityMw,null);assert.equal(result.capacityEvidence[0].valueMw,178);
});
test('projects without source-adapter coverage remain and independent evidence histories survive',()=>{
 const older={id:'one',lastVerifiedAt:'2026-01-01',capacityEvidence:[{id:'a',valueMw:1}],statusHistory:[{date:'2025-01-01',status:'construction',sourceUrl:'https://a.example'}]};
 const newer={id:'one',lastVerifiedAt:'2026-02-01',capacityEvidence:[{id:'a',valueMw:2},{id:'b',valueMw:3}],capacityEvidenceHistory:[{id:'a',valueMw:1,version:'v1'}]};
 const rows=mergeProjectRecords([{project:older},{project:newer},{project:{id:'two',owner:'Other'}}]);
 assert.equal(rows.length,2);assert.equal(rows[0].capacityEvidence.length,2);assert.equal(rows[0].capacityEvidence[0].valueMw,2);assert.equal(rows[0].capacityEvidenceHistory.length,1);assert.equal(rows[0].statusHistory.length,1);
});
