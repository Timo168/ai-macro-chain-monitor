import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig({root:resolve(process.cwd(),'pages'),base:process.env.PAGES_BASE_PATH??'/ai-macro-chain-monitor/',publicDir:resolve(process.cwd(),'public'),plugins:[react()],resolve:{alias:{'@':process.cwd()}},build:{outDir:resolve(process.cwd(),'dist-pages'),emptyOutDir:true},server:{host:'127.0.0.1',port:5174}});
