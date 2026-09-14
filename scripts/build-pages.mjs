import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--config','vite.pages.config.ts'],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);
const source=existsSync('data/latest.json')?'data/latest.json':'data/seed.json';const data=JSON.parse(readFileSync(source,'utf8'));
data.storage='github_pages';
// Only advertise scheduled operation when it was actually produced by that environment.
if(process.env.GITHUB_ACTIONS==='true')data.scheduler={...data.scheduler,mode:'github_actions',workflowUrl:'https://github.com/'+process.env.GITHUB_REPOSITORY+'/actions/workflows/deploy.yml'};
mkdirSync('dist-pages/data',{recursive:true});writeFileSync('dist-pages/data/latest.json',JSON.stringify(data));writeFileSync('dist-pages/.nojekyll','');
console.log('Pages build includes '+Object.keys(data.series).length+' real source series.');
const industryPath=existsSync('data/industry/latest.json')?'data/industry/latest.json':'data/industry/seed.json';
const industry=JSON.parse(readFileSync(industryPath,'utf8'));
if(process.env.GITHUB_ACTIONS==='true')industry.scheduler={...industry.scheduler,mode:'github_actions'};
const history=industry.recommendationHistory??[];
writeFileSync('dist-pages/data/industry.json',JSON.stringify({...industry,recommendationHistory:[]}));
writeFileSync('dist-pages/data/industry-history.json',JSON.stringify(history));
const version=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
writeFileSync('dist-pages/data/manifest.json',JSON.stringify({generatedAt:new Date().toISOString(),macro:{version:version(data),generatedAt:data.generatedAt},industry:{version:version(industry),generatedAt:industry.generatedAt}}));
