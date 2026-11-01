import test from 'node:test';
import assert from 'node:assert/strict';
import {mountGestureAppearance} from '../web/gesture-appearance.mjs';
const NS='http://www.w3.org/2000/svg';
const I=()=>({a:1,b:0,c:0,d:1,e:0,f:0});
const mul=(a,b)=>({a:a.a*b.a+a.c*b.b,b:a.b*b.a+a.d*b.b,c:a.a*b.c+a.c*b.d,d:a.b*b.c+a.d*b.d,e:a.a*b.e+a.c*b.f+a.e,f:a.b*b.e+a.d*b.f+a.f});
function parse(text='') {
 let m=I();for(const [,name,values] of text.matchAll(/(matrix|translate|scale|rotate)\(([^)]+)\)/gu)){
  const v=values.trim().split(/[\s,]+/u).map(Number);let t=I();
  if(name==='matrix')[t.a,t.b,t.c,t.d,t.e,t.f]=v;
  if(name==='translate'){t.e=v[0];t.f=v[1]??0;}
  if(name==='scale'){t.a=v[0];t.d=v[1]??v[0];}
  if(name==='rotate'){const r=v[0]*Math.PI/180;t.a=Math.cos(r);t.b=Math.sin(r);t.c=-t.b;t.d=t.a;}
  m=mul(m,t);
 }return m;
}
function transformed(box,m) {const p=[[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]].map(([x,y])=>({x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f}));const x=Math.min(...p.map(p=>p.x)),y=Math.min(...p.map(p=>p.y)),right=Math.max(...p.map(p=>p.x)),bottom=Math.max(...p.map(p=>p.y));return{x,y,width:right-x,height:bottom-y,left:x,top:y,right,bottom};}
class Element {
 constructor(name,doc){this.localName=name;this.namespaceURI=NS;this.ownerDocument=doc;this.parentNode=null;this.children=[];this.attrs=new Map();this._box=null;}
 get attributes(){return [...this.attrs].map(([name,value])=>({name,value}));} get childNodes(){return this.children;}
 setAttribute(k,v){this.attrs.set(k,String(v));}getAttribute(k){return this.attrs.get(k)??null;}removeAttribute(k){this.attrs.delete(k);}
 appendChild(child){child.parentNode?.removeChild(child);this.children.push(child);child.parentNode=this;return child;}
 insertBefore(child,before){child.parentNode?.removeChild(child);this.children.splice(this.children.indexOf(before),0,child);child.parentNode=this;return child;}
 removeChild(child){const i=this.children.indexOf(child);if(i<0)throw Error('not child');this.children.splice(i,1);child.parentNode=null;return child;}
 replaceChildren(...nodes){for(const c of [...this.children])this.removeChild(c);for(const n of nodes)this.appendChild(n);}
 contains(node){return node===this||this.children.some(c=>c.contains(node));}
 querySelectorAll(selector){const all=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);if(selector==='*')return all;const a=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u);return all.filter(n=>a?a[2]===undefined?n.getAttribute(a[1])!==null:n.getAttribute(a[1])===a[2]:n.localName===selector);}
 querySelector(s){return this.querySelectorAll(s)[0]??null;}
 cloneNode(deep){const c=new Element(this.localName,this.ownerDocument);c.attrs=new Map(this.attrs);c._box=this._box?{...this._box}:null;if(deep)for(const child of this.children)c.appendChild(child.cloneNode(true));return c;}
 getScreenCTM(){if(this.localName==='svg')return this._screen??I();return mul(this.parentNode?.getScreenCTM()??I(),parse(this.getAttribute('transform')??''));}
 getBBox(){if(this.getAttribute('display')==='none')return{x:0,y:0,width:0,height:0};if(this._box)return{...this._box};const boxes=this.children.filter(c=>c.getAttribute('display')!=='none').map(c=>transformed(c.getBBox(),parse(c.getAttribute('transform')??''))).filter(b=>b.width>0&&b.height>0);if(!boxes.length)return{x:0,y:0,width:0,height:0};const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return{x,y,width:Math.max(...boxes.map(b=>b.right))-x,height:Math.max(...boxes.map(b=>b.bottom))-y};}
 getBoundingClientRect(){if(this.localName==='svg')return{x:0,y:0,left:0,top:0,right:1600,bottom:1000,width:1600,height:1000};for(let n=this;n;n=n.parentNode)if(n.getAttribute('display')==='none')return{x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0};return transformed(this.getBBox(),this.getScreenCTM());}
}
function setup(){const doc={createElementNS:(ns,name)=>new Element(name,doc)};const svg=doc.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 1600 1000');return{svg,doc,adapter:mountGestureAppearance(svg)};}
function child(doc,tag,box,attrs={}){const n=doc.createElementNS(NS,tag);n._box=box;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
function object(svg,doc,id,tx,box,attrs={}){const n=doc.createElementNS(NS,'g');n.setAttribute('data-scene-object',id);n.setAttribute('transform',tx);n.appendChild(child(doc,'path',box,attrs));svg.appendChild(n);return n;}
const position=(id,x,y)=>({id,point:{x,y}});
const size=n=>{const r=n.getBoundingClientRect();return[r.width,r.height];};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);

test('a copied hero tree retains its visible shape and dimensions inside a native pine node',()=>{
 const {svg,doc,adapter}=setup();const source=object(svg,doc,'tree:0','translate(200 300) scale(2)',{x:0,y:0,width:200,height:300},{fill:'#e9bf59'});const dest=object(svg,doc,'tree:1','translate(1000 800)',{x:-10,y:-30,width:20,height:30});const nativePath=dest.children[0];
 const token=adapter.capture('tree:0',{x:.25,y:.9});assert.ok(Object.isFrozen(token));assert.ok(adapter.has(token));adapter.apply({'tree:1':token},[position('tree:0',.25,.9),position('tree:1',.625,.8)]);
 assert.equal(svg.querySelector('[data-scene-object="tree:1"]'),dest);assert.equal(nativePath.parentNode.getAttribute('display'),'none');assert.deepEqual(size(dest),size(source));const b=dest.getBoundingClientRect();near(b.x,800);near(b.y,200);assert.equal(dest.querySelector('[data-gesture-appearance="tree:1"]').querySelector('path').getAttribute('fill'),'#e9bf59');
 assert.equal(adapter.capture('tree:1',{x:.625,y:.8}),token);
 adapter.reset();assert.equal(dest.children[0],nativePath);assert.deepEqual(size(dest),[20,30]);assert.equal(dest.querySelectorAll('[data-gesture-appearance]').length,0);
});

test('frozen snapshots survive source deletion, renderer replacement, remapped IDs and repeated apply without nesting',()=>{
 const {svg,doc,adapter}=setup();const source=object(svg,doc,'mountain:0','translate(100 200) scale(1.5)',{x:-50,y:0,width:100,height:80});let dest=object(svg,doc,'mountain:1','translate(900 400)',{x:0,y:0,width:20,height:20});const token=adapter.capture('mountain:0',{x:.0625,y:.2});const overrides=Object.freeze({'mountain:1':token});
 for(let i=0;i<10;i++)adapter.apply(overrides,[position('mountain:1',.5625,.4)]);
 assert.equal(dest.querySelectorAll('[data-gesture-appearance]').length,1);assert.equal(dest.querySelectorAll('[data-gesture-appearance-original]').length,1);assert.deepEqual(size(dest),[150,120]);
 svg.removeChild(source);dest.replaceChildren(child(doc,'path',{x:0,y:0,width:12,height:14}));adapter.apply(overrides,[position('mountain:1',.5625,.4)]);assert.deepEqual(size(dest),[150,120]);
 svg.removeChild(dest);dest=object(svg,doc,'mountain:0','translate(600 500)',{x:0,y:0,width:10,height:10});adapter.apply({'mountain:0':token},[position('mountain:0',.375,.5)]);assert.deepEqual(size(dest),[150,120]);
 adapter.destroy();assert.deepEqual(size(dest),[10,10]);adapter.destroy();assert.throws(()=>adapter.apply({},[]));
});

function boat(svg,doc,id,tx,scale){const node=doc.createElementNS(NS,'g');node.setAttribute('data-scene-object',id);node.setAttribute('transform',tx);const art=doc.createElementNS(NS,'g');art.setAttribute('data-boat-art','');art.setAttribute('transform',`translate(6 2) rotate(10) scale(${scale})`);const wake=child(doc,'path',{x:-40,y:25,width:80,height:5},{'data-boat-wake':'',opacity:'.4'});art.appendChild(wake);art.appendChild(child(doc,'path',{x:-30,y:-50,width:60,height:75}));node.appendChild(art);svg.appendChild(node);return{node,art,wake};}
test('boats retain native animation references and copied size while following the destination motion',()=>{
 const {svg,doc,adapter}=setup();const source=boat(svg,doc,'boat:0','translate(400 600)',1.4),dest=boat(svg,doc,'boat:1','translate(900 650)',.7);const originalTransform=dest.art.getAttribute('transform');const token=adapter.capture('boat:0',{x:.25,y:.6});adapter.apply({'boat:1':token},[position('boat:1',.5625,.65)]);
 assert.equal(dest.art.getAttribute('transform'),originalTransform);assert.equal(dest.wake.parentNode.getAttribute('display'),'none');const copy=dest.art.querySelector('[data-gesture-appearance]');const m=copy.getScreenCTM();near(Math.hypot(m.a,m.b),1.4);near(parse(copy.getAttribute('transform')).a,2);
 dest.art.setAttribute('transform','translate(25 4) rotate(-8) scale(.5)');dest.wake.setAttribute('opacity','.87');adapter.apply({'boat:1':token},[position('boat:1',.5625,.65)]);near(Math.hypot(copy.getScreenCTM().a,copy.getScreenCTM().b),1.4);assert.equal(copy.children[0].getAttribute('opacity'),'.87');assert.equal(dest.wake.getAttribute('opacity'),'.87');adapter.reset();assert.equal(dest.art.children[0],dest.wake);
});

function bird(svg,doc,id,span){const node=doc.createElementNS(NS,'g');node.setAttribute('data-scene-object',id);node.setAttribute('transform','translate(500 250)');const art=doc.createElementNS(NS,'g');art.setAttribute('data-bird-art','');art.setAttribute('transform','translate(12 4) rotate(3)');const wing=child(doc,'path',{x:-span,y:-8,width:span*2,height:10},{d:`M${-span} 0Q${-span*.5} -4 0 0Q${span*.5} -3.6 ${span} -1`});art.appendChild(wing);node.appendChild(art);svg.appendChild(node);return{node,art,wing};}
test('copied birds keep their source wing span but update the flap from the original animation reference',()=>{
 const {svg,doc,adapter}=setup();const source=bird(svg,doc,'bird:0',13),dest=bird(svg,doc,'bird:1',8);const token=adapter.capture('bird:0',{x:.3125,y:.25});adapter.apply({'bird:1':token},[position('bird:1',.3125,.25)]);const copiedWing=dest.art.querySelector('[data-gesture-appearance]').querySelector('path');assert.match(copiedWing.getAttribute('d'),/^M-13 0Q-6\.5 -4/u);
 dest.wing.setAttribute('d','M-8 0Q-4 -7 0 0Q4 -6.3 8 -1');adapter.apply({'bird:1':token},[position('bird:1',.3125,.25)]);assert.equal(copiedWing.getAttribute('d'),'M-13 0Q-6.5 -7 0 0Q6.5 -6.3 13 -1');assert.equal(dest.wing.getAttribute('d'),'M-8 0Q-4 -7 0 0Q4 -6.3 8 -1');assert.equal(dest.wing.parentNode.getAttribute('display'),'none');
});

test('artwork clones remove active resources and internal identities while retaining same-SVG paints',()=>{
 const {svg,doc,adapter}=setup();const paint=child(doc,'linearGradient',null,{id:'local-paint'});svg.appendChild(paint);const source=object(svg,doc,'tree:0','translate(300 400)',{x:0,y:0,width:50,height:70},{fill:'url(#local-paint)',stroke:'url(https://example.invalid/a)',id:'private-shape',role:'button',tabindex:'0','data-scene-object':'bird:9',onclick:'bad()',style:'filter:url(https://example.invalid/b)',class:'source-class'});source.appendChild(child(doc,'image',null,{href:'https://example.invalid/image'}));source.appendChild(child(doc,'script',null));const dest=object(svg,doc,'tree:1','translate(800 500)',{x:0,y:0,width:10,height:10});const token=adapter.capture('tree:0',{x:.1875,y:.4});adapter.apply({'tree:1':token},[position('tree:1',.5,.5)]);const copy=dest.querySelector('[data-gesture-appearance]'),path=copy.querySelector('path');assert.equal(path.getAttribute('fill'),'url(#local-paint)');for(const name of ['stroke','id','role','tabindex','data-scene-object','onclick','style','class'])assert.equal(path.getAttribute(name),null,name);assert.equal(copy.querySelector('image'),null);assert.equal(copy.querySelector('script'),null);assert.equal(copy.querySelector('[data-scene-object]'),null);
});

test('invalid or foreign snapshots and unsafe records reject before replacing visible artwork',()=>{
 const {svg,doc,adapter}=setup();object(svg,doc,'tree:0','translate(300 400)',{x:0,y:0,width:50,height:70});const dest=object(svg,doc,'tree:1','translate(800 500)',{x:0,y:0,width:10,height:10});const token=adapter.capture('tree:0',{x:.1875,y:.4});adapter.apply({'tree:1':token},[position('tree:1',.5,.5)]);const copy=dest.querySelector('[data-gesture-appearance]');
 assert.throws(()=>adapter.apply({'bird:0':token},[]));assert.throws(()=>adapter.apply({'tree:1':Object.freeze({assetId:token.assetId,kind:'tree'})},[]));assert.throws(()=>adapter.apply({'tree:1':token},[]));assert.equal(dest.querySelector('[data-gesture-appearance]'),copy);
 let touched=0;const getter={};Object.defineProperty(getter,'tree:1',{enumerable:true,get(){touched++;return token;}});assert.throws(()=>adapter.apply(getter,[]));const anchor={};Object.defineProperties(anchor,{x:{enumerable:true,get(){touched++;return .5;}},y:{value:.5,enumerable:true}});assert.throws(()=>adapter.capture('tree:0',anchor));const positions=[];Object.defineProperty(positions,'0',{enumerable:true,get(){touched++;return position('tree:1',.5,.5);}});assert.throws(()=>adapter.apply({'tree:1':token},positions));assert.equal(touched,0);assert.equal(dest.querySelector('[data-gesture-appearance]'),copy);
 assert.throws(()=>adapter.capture('sun',{x:.2,y:.3}));assert.throws(()=>adapter.capture('tree:99',{x:.2,y:.3}));
});


test('offscreen native anchors from a narrow slice camera do not break unrelated visible overrides',()=>{
 const {svg,doc,adapter}=setup();object(svg,doc,'tree:0','translate(300 400)',{x:0,y:0,width:50,height:70});const dest=object(svg,doc,'tree:1','translate(800 500)',{x:0,y:0,width:10,height:10});const token=adapter.capture('tree:0',{x:.1875,y:.4});
 const positions=[position('tree:1',.5,.5),position('tree:2',-1.8,.6),position('tree:3',2.7,.7)];
 adapter.apply({},positions);adapter.apply({'tree:1':token},positions);assert.deepEqual(size(dest),[50,70]);
 assert.throws(()=>adapter.capture('tree:2',{x:-1.8,y:.6}));
});
