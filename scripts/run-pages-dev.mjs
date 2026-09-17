import {fileURLToPath} from 'node:url';

process.env.VITE_LOCAL_PREVIEW='true';
const args=process.argv.slice(2);
const hasPort=args.some(value=>value==='--port'||value.startsWith('--port='));
const cli=new URL('../node_modules/vite/bin/vite.js',import.meta.url);
process.argv=[process.execPath,fileURLToPath(cli),'--config','vite.pages.config.ts','--host','127.0.0.1',...(hasPort?[]:['--port','5173']),...args];
await import(cli.href);
