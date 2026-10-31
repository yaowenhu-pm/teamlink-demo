import assets from 'virtual:site-assets';
import {handleRooms} from './rooms.mjs';
import {createInterpreter} from './interpret.mjs';
const TYPES={html:'text/html; charset=utf-8',mjs:'text/javascript; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',png:'image/png',json:'application/json; charset=utf-8'};
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==='/api/health')return Response.json({ok:true,mode:env.CLAW_API_KEY?'ai':'commands',roomTtlHours:6},{headers:{'Cache-Control':'no-store'}});
 if(url.pathname.startsWith('/api/')){try{return await handleRooms(request,env,env.CLAW_API_KEY?{interpret:createInterpreter(env),mode:'ai'}:{mode:'commands'})??Response.json({error:'接口不存在。'},{status:404});}catch{return Response.json({error:'暂时无法完成请求，请稍后重试。'},{status:503,headers:{'Cache-Control':'no-store'}});}}
 if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
 let path;try{path=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400});}
 if(path==='/app'||path==='/app/'){url.pathname='/legacy/app/';return Response.redirect(url.href,302);}
 if(path.endsWith('/'))path+='index.html';
 let file=assets[path];
 if(!file&&/^\/[a-zA-Z0-9._-]+$/.test(path))file=assets['/legacy'+path];
 if(!file)return new Response('Page not found',{status:404});
 const content=file.encoding==='base64'?Uint8Array.from(atob(file.content),char=>char.charCodeAt(0)):file.content;
 const ext=path.split('.').at(-1);const headers={'Content-Type':TYPES[ext]??'application/octet-stream','Cache-Control':ext==='html'?'no-cache':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 return new Response(request.method==='HEAD'?null:content,{headers});
}};
