import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const proofName='frontend-build.json';
function frontendFiles(root,folder=''){
 return readdirSync(join(root,folder),{withFileTypes:true}).flatMap(entry=>{
  const relative=[folder,entry.name].filter(Boolean).join('/');
  if(relative==='data'||relative===proofName||relative==='.nojekyll')return [];
  if(entry.isSymbolicLink())throw Error('Cached frontend contains an unexpected symbolic link');
  return entry.isDirectory()?frontendFiles(root,relative):[relative];
 }).sort();
}

export function recordFrontend(root,{commitSha,basePath}){
 if(!existsSync(join(root,'index.html')))throw Error('Frontend index is missing');
 const files=Object.fromEntries(frontendFiles(root).map(file=>[file,digest(readFileSync(join(root,file)))]));
 const proof={version:1,commitSha,basePath,files};
 writeFileSync(join(root,proofName),JSON.stringify(proof));
 return proof;
}

export function verifyFrontend(root,{commitSha,basePath}){
 if(!commitSha||commitSha==='local-build')throw Error('Data-only packaging requires an explicit source commit');
 const proof=JSON.parse(readFileSync(join(root,proofName),'utf8'));
 if(proof.version!==1||proof.commitSha!==commitSha||proof.basePath!==basePath)throw Error('Cached frontend belongs to a different source commit or base path');
 const files=frontendFiles(root);
 if(!proof.files?.['index.html']||JSON.stringify(files)!==JSON.stringify(Object.keys(proof.files).sort()))throw Error('Cached frontend file list changed');
 for(const file of files){
  const path=resolve(root,file);
  if(!path.startsWith(resolve(root)+'/')&&!path.startsWith(resolve(root)+'\\'))throw Error('Invalid cached frontend path');
  if(digest(readFileSync(path))!==proof.files[file])throw Error('Cached frontend asset changed: '+file);
 }
 return proof;
}
