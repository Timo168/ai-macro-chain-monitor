import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordFrontend,verifyFrontend} from '../scripts/pages-package.mjs';

function fixture(t){
 const folder=mkdtempSync(join(tmpdir(),'macro-pages-proof-'));
 t.after(()=>rmSync(folder,{recursive:true,force:true}));
 mkdirSync(join(folder,'assets'));mkdirSync(join(folder,'data'));
 writeFileSync(join(folder,'index.html'),'<script src="/site/assets/app.js"></script>');
 writeFileSync(join(folder,'assets/app.js'),'console.log("verified build")');
 const identity={commitSha:'source-commit',basePath:'/site/'};
 recordFrontend(folder,identity);
 return {folder,identity};
}
test('A cached frontend may receive new data without changing its code identity',t=>{
 const {folder,identity}=fixture(t);
 writeFileSync(join(folder,'data/latest.json'),'{"newObservation":true}');
 assert.equal(verifyFrontend(folder,identity).commitSha,identity.commitSha);
});
test('A source or base-path mismatch cannot publish a cached frontend',t=>{
 const {folder,identity}=fixture(t);
 assert.throws(()=>verifyFrontend(folder,{...identity,commitSha:'other'}),/different source/);
 assert.throws(()=>verifyFrontend(folder,{...identity,basePath:'/other/'}),/different source/);
 assert.throws(()=>verifyFrontend(folder,{...identity,commitSha:''}),/explicit source/);
});
test('Changed or missing JS assets fail closed before data-only publication',t=>{
 const {folder,identity}=fixture(t);
 writeFileSync(join(folder,'assets/app.js'),'tampered');
 assert.throws(()=>verifyFrontend(folder,identity),/asset changed/);
 rmSync(join(folder,'assets/app.js'));
 assert.throws(()=>verifyFrontend(folder,identity),/file list changed/);
});
