import {build} from 'esbuild';
import {readFile,readdir,mkdir,rm,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),web=path.join(root,'web'),out=path.join(root,'dist');
const files={};
async function walk(directory){for(const item of await readdir(directory,{withFileTypes:true})){const full=path.join(directory,item.name);if(item.isDirectory())await walk(full);else{const key='/'+path.relative(web,full).split(path.sep).join('/');const binary=/\.(png|jpg|jpeg|webp|woff2|ico)$/i.test(item.name);files[key]={encoding:binary?'base64':'utf8',content:await readFile(full,binary?'base64':'utf8')};}}}
await walk(web);
const frontend=await build({entryPoints:['web/world.mjs'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',legalComments:'inline',minify:false});
files['/world.mjs']={encoding:'utf8',content:frontend.outputFiles[0].text};
for(const name of ['world.mjs','world.css']){const fingerprint=createHash('sha256').update(files['/'+name].content).digest('hex').slice(0,12);files['/index.html'].content=files['/index.html'].content.replace('/'+name+'"','/'+name+'?v='+fingerprint+'"');}
await rm(out,{recursive:true,force:true});await mkdir(path.join(out,'server'),{recursive:true});await mkdir(path.join(out,'.openai'),{recursive:true});
await build({entryPoints:['worker/index.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(out,'server/index.js'),plugins:[{name:'static-files',setup(b){b.onResolve({filter:/^virtual:site-assets$/},()=>({path:'site-assets',namespace:'embedded'}));b.onLoad({filter:/.*/,namespace:'embedded'},()=>({contents:'export default '+JSON.stringify(files),loader:'js'}));}}]});
const hosting=await readFile('.openai/hosting.json','utf8').catch(error=>{if(error.code==='ENOENT')return JSON.stringify({d1:'DB',r2:null});throw error;});
await writeFile(path.join(out,'.openai/hosting.json'),hosting);await cp('drizzle',path.join(out,'.openai/drizzle'),{recursive:true});
const module=await import('file://'+path.join(out,'server/index.js')+'?check='+Date.now());if(typeof module.default?.fetch!=='function')throw Error('Worker fetch handler missing');
console.log(JSON.stringify({built:true,staticFiles:Object.keys(files).length,workerBytes:(await readFile(path.join(out,'server/index.js'))).byteLength}));
