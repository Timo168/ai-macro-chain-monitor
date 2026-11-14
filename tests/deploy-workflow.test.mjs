import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {load} from 'js-yaml';
import {recordFrontend,verifyFrontend} from '../scripts/pages-package.mjs';

const workflow=load(readFileSync(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8'));
const steps=workflow.jobs.build.steps;

// Deliberately reject conditions this test cannot evaluate instead of silently
// treating a newly introduced branch as executable.
function runsInCacheScenario(step,reusable){
 if(step.if===undefined)return true;
 const expression=String(step.if).trim().replace(/^\$\{\{\s*|\s*\}\}$/g,'');
 const match=/^steps\.frontend-proof\.outputs\.reusable\s*(==|!=)\s*'true'$/.exec(expression);
 assert.ok(match,`Unsupported deployment condition: ${expression}`);
 return match[1]==='=='?reusable:!reusable;
}

for(const reusable of [true,false]){
 test(`deployment ${reusable?'cache hit':'cache miss'} installs dependencies before tests and selects one packaging path`,()=>{
  const active=steps.filter(step=>runsInCacheScenario(step,reusable));
  const install=active.findIndex(step=>/^\s*npm ci\s*$/m.test(step.run??''));
  assert.notEqual(install,-1,'Every fresh runner needs npm ci, including a frontend cache hit');
  const nodeTests=active.map((step,index)=>({step,index})).filter(({step})=>/\bnode\s+--test\b/.test(step.run??''));
  assert.ok(nodeTests.length>0,'The workflow must still execute its regression tests');
  assert.ok(nodeTests.some(({step})=>step.run.includes('tests/metric-explorer.test.mjs')),'Keep the React rendering regression in the tested execution path');
  assert.ok(nodeTests.every(({index})=>install<index),'Install React and build dependencies before any Node test step');
  assert.equal(active.filter(step=>/npm run build:pages/.test(step.run??'')).length,reusable?0:1);
  assert.equal(active.filter(step=>/node scripts\/build-pages\.mjs --data-only/.test(step.run??'')).length,reusable?1:0);
  assert.equal(active.filter(step=>(step.uses??'').startsWith('actions/cache/save@')).length,reusable?0:1);
  assert.equal(active.filter(step=>/npx tsc --noEmit/.test(step.run??'')).length,reusable?0:1);
  assert.ok(active.some(step=>(step.uses??'').startsWith('actions/upload-pages-artifact@')));
 });
}

test('the workflow retains npm downloads and verifies exact-source frontend assets before reuse',()=>{
 assert.ok(steps.some(step=>(step.uses??'').startsWith('actions/setup-node@')&&step.with?.cache==='npm'));
 const restore=steps.find(step=>(step.uses??'').startsWith('actions/cache/restore@'));
 assert.equal(restore.with.path,'dist-pages');
 assert.ok(restore.with.key.includes('github.sha'));
 assert.ok(restore.with.key.includes("hashFiles('package-lock.json')"));
 assert.equal(restore.with['restore-keys'],undefined,'Do not substitute a frontend built from another source version');
 const proof=steps.find(step=>step.id==='frontend-proof');
 assert.match(proof.env.CACHE_HIT,/steps\.frontend\.outputs\.cache-hit/);
 assert.match(proof.run,/if \[ "\$CACHE_HIT" = 'true' \] && node scripts\/build-pages\.mjs --check-frontend; then/);
 assert.match(proof.run,/echo 'reusable=true'/);
 assert.match(proof.run,/else\s+echo 'reusable=false'/);
 assert.ok(steps.indexOf(proof)<steps.findIndex(step=>/node\s+--test/.test(step.run??'')));
});

const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const writeJson=(path,value)=>writeFileSync(path,JSON.stringify(value));
const version=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
function fixture(t){
 const folder=mkdtempSync(join(tmpdir(),'macro-deploy-regression-'));
 t.after(()=>{
  assert.equal(dirname(resolve(folder)),resolve(tmpdir()));
  assert.ok(basename(folder).startsWith('macro-deploy-regression-'));
  rmSync(folder,{recursive:true,force:true});
 });
 for(const directory of ['scripts','data/industry','dist-pages/assets','dist-pages/data'])mkdirSync(join(folder,directory),{recursive:true});
 for(const file of ['build-pages.mjs','pages-package.mjs'])copyFileSync(new URL(`../scripts/${file}`,import.meta.url),join(folder,'scripts',file));
 writeFileSync(join(folder,'dist-pages/index.html'),'<script src="/ai-macro-chain-monitor/assets/app.js"></script>');
 writeFileSync(join(folder,'dist-pages/assets/app.js'),'console.log("stable frontend")');
 const identity={commitSha:'fixture-source-commit',basePath:'/ai-macro-chain-monitor/'};
 const proof=recordFrontend(join(folder,'dist-pages'),identity);
 const macro={generatedAt:'2026-11-11T01:00:00Z',series:{TEST:{observations:[{date:'2026-11-10',value:4.1}]}}};
 writeJson(join(folder,'data/latest.json'),macro);
 writeJson(join(folder,'data/industry/latest.json'),{generatedAt:macro.generatedAt,recommendationHistory:[{id:'retained-history'}]});
 writeJson(join(folder,'data/industry/audit-status.json'),{status:'ready',completedAt:macro.generatedAt});
 writeJson(join(folder,'data/industry/research.json'),{generatedAt:macro.generatedAt});
 writeJson(join(folder,'data/industry/research-history.json'),[{id:'research-history'}]);
 for(const file of ['policy-rates.json','policy-decisions.json','regional-energy.json'])writeJson(join(folder,'data',file),{generatedAt:macro.generatedAt});
 writeJson(join(folder,'data/calendar.json'),{checkedAt:macro.generatedAt});
 const previous={oldPublishedData:true};
 writeJson(join(folder,'dist-pages/data/latest.json'),previous);
 writeJson(join(folder,'dist-pages/data/manifest.json'),previous);
 return {folder,identity,proof,macro,previous};
}
function runPackager(fixture,mode){
 const result=spawnSync(process.execPath,[join(fixture.folder,'scripts/build-pages.mjs'),mode],{
  cwd:fixture.folder,encoding:'utf8',stdio:'pipe',windowsHide:true,timeout:15000,
  env:{...process.env,GITHUB_SHA:fixture.identity.commitSha,PAGES_BASE_PATH:fixture.identity.basePath,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'Timo168/ai-macro-chain-monitor'},
 });
 assert.ifError(result.error);
 return result;
}

test('the real data-only entry point publishes fresh snapshots without rebuilding or changing frontend assets',t=>{
 const value=fixture(t),output=join(value.folder,'dist-pages');
 assert.equal(existsSync(join(value.folder,'node_modules')),false);
 let result=runPackager(value,'--check-frontend');
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(readJson(join(output,'data/latest.json')),value.previous,'Identity checking must not publish data');
 result=runPackager(value,'--data-only');
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/Reusing verified frontend/);
 assert.deepEqual(verifyFrontend(output,value.identity),value.proof);
 const published=readJson(join(output,'data/latest.json'));
 assert.deepEqual(published.series,value.macro.series);
 assert.equal(published.generatedAt,value.macro.generatedAt);
 assert.equal(published.storage,'github_pages');
 assert.equal(published.scheduler.mode,'github_actions');
 assert.deepEqual(readJson(join(output,'data/industry-history.json')),[{id:'retained-history'}]);
 assert.deepEqual(readJson(join(output,'data/industry-research-history.json')),[{id:'research-history'}]);
 assert.deepEqual(readJson(join(output,'data/industry.json')).recommendationHistory,[]);
 const manifest=readJson(join(output,'data/manifest.json'));
 assert.equal(manifest.macro.version,version(value.macro));
 assert.equal(manifest.macro.generatedAt,value.macro.generatedAt);
 assert.equal(manifest.macro.lastCompletedAt,null);
 for(const section of ['industry','industryResearch','policyRates','policyDecisions','researchCalendar','regionalEnergy','sourceAudit'])assert.match(manifest[section].version,/^[a-f0-9]{16}$/);
 const newer={...value.macro,generatedAt:'2026-11-11T01:15:00Z',scheduler:{lastCompletedAt:'2026-11-11T01:17:00Z'},series:{TEST:{observations:[...value.macro.series.TEST.observations,{date:'2026-11-11',value:4.2}]}}};
 writeJson(join(value.folder,'data/latest.json'),newer);
 result=runPackager(value,'--data-only');
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(readJson(join(output,'data/latest.json')).series,newer.series);
 const updated=readJson(join(output,'data/manifest.json'));
 assert.equal(updated.macro.version,version(newer));
 assert.notEqual(updated.macro.version,manifest.macro.version);
 assert.equal(updated.macro.generatedAt,newer.generatedAt);
 assert.equal(updated.macro.lastCompletedAt,newer.scheduler.lastCompletedAt);
 assert.deepEqual(verifyFrontend(output,value.identity),value.proof);
});

for(const corruption of ['asset','source identity','missing proof']){
 test(`the real packager rejects ${corruption} corruption before replacing any published data`,t=>{
  const value=fixture(t),output=join(value.folder,'dist-pages');
  if(corruption==='asset')writeFileSync(join(output,'assets/app.js'),'changed');
  else if(corruption==='source identity')writeJson(join(output,'frontend-build.json'),{...value.proof,commitSha:'wrong-source'});
  else rmSync(join(output,'frontend-build.json'));
  for(const mode of ['--check-frontend','--data-only']){
   const result=runPackager(value,mode);
   assert.notEqual(result.status,0,`${mode} must reject the invalid cache`);
   assert.match(result.stderr,/Cached frontend asset changed|different source commit|ENOENT/);
   assert.deepEqual(readJson(join(output,'data/latest.json')),value.previous);
   assert.deepEqual(readJson(join(output,'data/manifest.json')),value.previous);
  }
 });
}
