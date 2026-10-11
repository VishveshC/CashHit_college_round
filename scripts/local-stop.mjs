import path from 'node:path';import {stopOwnedWeb} from './local-runtime.mjs';
stopOwnedWeb(path.resolve('infra/local/runtime'));console.log('Owned local web stopped.');
// Anvil shutdown is delegated to its own identity-checked lifecycle helper.
try{const module=await import('./phase4/runtime.mjs');if(typeof module.stopOwnedAnvil==='function'){await module.stopOwnedAnvil();console.log('Owned local chain stopped.');}}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
