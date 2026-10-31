// Toolchains may invoke helper commands such as `net use`. Keep all of those
// helpers hidden on Windows, including calls made inside third-party packages.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
if(process.platform==='win32'){
 for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']){
  const original=childProcess[name];
  childProcess[name]=function(...args){
   const index=name.startsWith('exec')&&!name.startsWith('execFile')?1:Array.isArray(args[1])?2:1;
   if(args[index]&&typeof args[index]==='object')args[index]={...args[index],windowsHide:true};
   else args.splice(index,0,{windowsHide:true});
   return original.apply(this,args);
  };
 }
 syncBuiltinESMExports();
}
