// Portable Ollama download. Model weights and binaries stay out of Git.
import {createWriteStream, createReadStream, existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {resolve} from 'node:path';

const directory=resolve('outputs/local-reasoning');
mkdirSync(directory,{recursive:true});
const response=await fetch('https://api.github.com/repos/ollama/ollama/releases/latest',{
 headers:{'User-Agent':'ai-macro-chain-monitor-local-setup'},signal:AbortSignal.timeout(30000),
});
if(!response.ok)throw Error(`无法读取 Ollama 官方版本：HTTP ${response.status}`);
const release=await response.json();
const asset=release.assets?.find(item=>item.name==='ollama-windows-amd64.zip');
if(!asset?.browser_download_url?.startsWith('https://github.com/ollama/ollama/releases/download/')||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??''))throw Error('官方安装包缺少可核验地址或 SHA256，停止下载。');
const path=resolve(directory,asset.name);
const sha256=async file=>{const hash=createHash('sha256');for await(const part of createReadStream(file))hash.update(part);return hash.digest('hex');};
const expected=asset.digest.slice(7);
if(!existsSync(path)||await sha256(path)!==expected){
 console.log(`下载官方 Ollama ${release.tag_name}，约 ${(asset.size/1e9).toFixed(2)} GB；后台运行。`);
 const part=path+'.part',manifest=part+'.json';
 let priorSource=null;try{priorSource=JSON.parse(readFileSync(manifest,'utf8'));}catch{}
 // A partial archive belongs to one exact release. Never append another version.
 const offset=priorSource?.sha256===expected&&existsSync(part)?statSync(part).size:0;
 writeFileSync(manifest,JSON.stringify({url:asset.browser_download_url,sha256:expected,size:asset.size}));
 const download=await fetch(asset.browser_download_url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal:AbortSignal.timeout(5*60*1000)});
 if(!download.ok||!download.body)throw Error(`下载失败：HTTP ${download.status}`);
 if(download.status===206&&!download.headers.get('content-range')?.startsWith(`bytes ${offset}-`))throw Error('下载续传范围不匹配，停止。');
 try{await pipeline(Readable.fromWeb(download.body),createWriteStream(part,{flags:download.status===206?'a':'w'}));}
 catch{console.error('官方安装包下载未完成，已保留部分文件；稍后重试可续传。不执行未校验文件。');process.exit(1);}
 if(await sha256(part)!==expected)throw Error('下载校验失败，不执行安装包。');
 renameSync(part,path);
}
writeFileSync(resolve(directory,'runtime-source.json'),JSON.stringify({version:release.tag_name,url:asset.browser_download_url,size:asset.size,sha256:expected,verifiedAt:new Date().toISOString()},null,2));
console.log(`官方安装包 SHA256 已验证：${release.tag_name}`);
