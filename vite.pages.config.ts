import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {localData} from './build/local-data';
const localPreview=process.env.VITE_LOCAL_PREVIEW==='true';
export default defineConfig({root:resolve(process.cwd(),'pages'),base:process.env.PAGES_BASE_PATH??(localPreview?'/':'/ai-macro-chain-monitor/'),publicDir:resolve(process.cwd(),'public'),plugins:[localData(),react()],resolve:{alias:{'@':process.cwd()}},build:{outDir:resolve(process.cwd(),'dist-pages'),emptyOutDir:true},server:{host:'127.0.0.1',port:5174}});
