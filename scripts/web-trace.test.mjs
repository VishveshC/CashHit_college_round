import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
test('local server trace excludes generated private runtime data and secrets',()=>{
 const root=process.cwd(),server=path.join(root,'apps/web/.next/server'),traces=[];
 function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.name.endsWith('.nft.json'))traces.push(full);}}
 walk(server);assert.ok(traces.length>0,'build the local web app before this artifact check');
 for(const trace of traces){const files=JSON.parse(readFileSync(trace,'utf8')).files;assert.ok(Array.isArray(files));for(const file of files){const absolute=path.resolve(path.dirname(trace),file).replaceAll('\\','/');assert.equal(absolute.includes('/infra/local/runtime/'),false,'server packaging must not include generated private runtime data: '+file);}}
});
