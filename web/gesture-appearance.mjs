/** Lab-only visual snapshots. Tokens stay in memory; no SVG is read from a clipboard. */
const NS = 'http://www.w3.org/2000/svg';
const NATIVE = /^(tree|boat|mountain|bird):(0|[1-9]\d?)$/u;
const ELEMENTS = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const identity = () => ({a:1,b:0,c:0,d:1,e:0,f:0});
const mul = (a,b) => ({a:a.a*b.a+a.c*b.b,b:a.b*b.a+a.d*b.b,c:a.a*b.c+a.c*b.d,d:a.b*b.c+a.d*b.d,e:a.a*b.e+a.c*b.f+a.e,f:a.b*b.e+a.d*b.f+a.f});
const translate = (x,y) => ({a:1,b:0,c:0,d:1,e:x,f:y});
function matrix(value) {
  if (!value || !['a','b','c','d','e','f'].every(k=>Number.isFinite(value[k]))) throw new RangeError('Invalid rendered artwork matrix.');
  return Object.fromEntries(['a','b','c','d','e','f'].map(k=>[k,value[k]]));
}
function inverse(value) {
  const m=matrix(value),det=m.a*m.d-m.b*m.c;
  if(Math.abs(det)<1e-10)throw new RangeError('Artwork matrix is not invertible.');
  return {a:m.d/det,b:-m.b/det,c:-m.c/det,d:m.a/det,e:(m.c*m.f-m.d*m.e)/det,f:(m.b*m.e-m.a*m.f)/det};
}
function record(value,label) {
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(`${label} must be a plain object.`);
  return Reflect.ownKeys(value).map(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw new TypeError(`${label} must contain data properties.`);
    return [key,descriptor.value];
  });
}
function nativeId(id) {const match=typeof id==='string'&&id.match(NATIVE);if(!match)throw new RangeError('Only an individual tree, mountain, boat or bird can have copied artwork.');return match[1];}
function point(value,normalized=true) {
  const fields=record(value,'Artwork anchor');
  if(fields.length!==2||!fields.some(([k])=>k==='x')||!fields.some(([k])=>k==='y'))throw new RangeError('Artwork anchors need x/y.');
  const result=Object.fromEntries(fields);
  if(![result.x,result.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6&&(!normalized||(v>=0&&v<=1))))throw new RangeError('Artwork anchors must be finite camera points.');
  return result;
}
const fixed = value => String((Math.round(value*1e7)/1e7)||0);
const transform = m => `matrix(${['a','b','c','d','e','f'].map(k=>fixed(m[k])).join(' ')})`;
function relative(svg,node) {return mul(inverse(svg.getScreenCTM()),matrix(node.getScreenCTM()));}
function worldPoint(svg,normalized) {
  const rect=svg.getBoundingClientRect(),box=svg.viewBox?.baseVal;
  const raw=(svg.getAttribute('viewBox')??'0 0 1600 1000').split(/[\s,]+/u).map(Number);
  const width=box?.width||raw[2],height=box?.height||raw[3],x=box?.x??raw[0],y=box?.y??raw[1];
  if(![rect.width,rect.height,width,height,x,y].every(Number.isFinite)||Math.min(rect.width,rect.height,width,height)<=0)throw new RangeError('Artwork requires a visible SVG canvas.');
  const spanX=Math.min(width,height*rect.width/rect.height),spanY=Math.min(height,width*rect.height/rect.width);
  const result={x:x+(width-spanX)/2+normalized.x*spanX,y:y+(height-spanY)/2+normalized.y*spanY};
  if(![result.x,result.y].every(Number.isFinite))throw new RangeError('Artwork anchor exceeds the SVG camera.');
  return result;
}
function route(root,node) {
  if(!node)return null;
  const steps=[];
  while(node&&node!==root){const parent=node.parentNode;if(!parent)return null;steps.unshift(Array.from(parent.children).indexOf(node));node=parent;}
  return node===root?steps:null;
}
function follow(root,steps) {return steps?.reduce((node,index)=>node?.children[index],root)??null;}
function sanitize(root,svg) {
  for(const node of [root,...Array.from(root.querySelectorAll('*'))]) {
    if(node!==root&&!ELEMENTS.has(node.localName)){node.parentNode?.removeChild(node);continue;}
    for(const {name,value} of Array.from(node.attributes)) {
      const lower=name.toLowerCase();
      if(lower==='id'||lower==='class'||lower==='style'||lower==='role'||lower==='tabindex'||lower.startsWith('data-')||lower.startsWith('aria-')||lower.startsWith('on')||lower.includes('href')){node.removeAttribute(name);continue;}
      if(/url\s*\(/iu.test(value)) {
        const reference=value.match(/^url\(["']?#([A-Za-z0-9_-]+)["']?\)$/u);
        if(!reference||!svg.querySelector(`[id="${reference[1]}"]`))node.removeAttribute(name);
      }
    }
  }
}
function positionsOf(values) {
  if(!Array.isArray(values)||Object.getPrototypeOf(values)!==Array.prototype||values.length>136||Reflect.ownKeys(values).length!==values.length+1)throw new TypeError('Rendered artwork positions must be a dense array.');
  const items=Array.from({length:values.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(values,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Rendered artwork positions must contain data entries.');return d.value;});
  const result=new Map();
  for(const value of items){const data=Object.fromEntries(record(value,'Rendered artwork position'));const kind=nativeId(data.id);if(result.has(data.id))throw new RangeError('Duplicate rendered artwork identity.');result.set(data.id,{kind,point:point(data.point,false)});}
  return result;
}

/**
 * Call apply AFTER renderer.render and BEFORE gesture-decor.apply. Native outer
 * nodes and art containers are retained: the renderer can still animate its own
 * wing/wake references and delegate pointer events to data-scene-object. Only
 * descendant artwork is hidden, and a cloned snapshot is inserted beside it.
 * The lab should use its measured target highlight instead of the renderer's
 * cached native selection box for overridden objects.
 */
export function mountGestureAppearance(svg) {
  if(svg?.namespaceURI!==NS||svg.localName!=='svg'||!svg.ownerDocument?.createElementNS)throw new TypeError('Artwork snapshots require an SVG canvas.');
  const document=svg.ownerDocument,assets=new WeakMap(),live=new Map();
  let applied=Object.freeze({}),serial=0,destroyed=false;
  const nodeFor=id=>svg.querySelector(`[data-scene-object="${id}"]`);
  function checkedOverrides(value) {
    const entries=record(value,'Artwork overrides');if(entries.length>136)throw new RangeError('Too many artwork overrides.');
    for(const [id,token] of entries){const kind=nativeId(id),asset=token&&typeof token==='object'&&assets.get(token);if(!asset||asset.kind!==kind)throw new RangeError('Unknown or mismatched artwork snapshot.');}
    return Object.freeze(Object.fromEntries(entries));
  }
  function restore(entry) {
    if(entry.original.parentNode===entry.body){for(const child of Array.from(entry.original.childNodes))entry.body.insertBefore(child,entry.original);entry.body.removeChild(entry.original);}
    if(entry.copy.parentNode===entry.body)entry.body.removeChild(entry.copy);
  }
  function capture(id,anchor) {
    if(destroyed)throw new Error('Artwork snapshots have been destroyed.');
    const kind=nativeId(id),normalized=point(anchor),node=nodeFor(id),bounds=node?.getBoundingClientRect();
    if(!node||!svg.contains(node)||!bounds||bounds.width<=0||bounds.height<=0)throw new RangeError('The source object must be visible to copy it.');
    if(applied[id])return applied[id];
    const body=kind==='boat'?node.querySelector('[data-boat-art]'):kind==='bird'?node.querySelector('[data-bird-art]'):node;
    if(!body)throw new RangeError('The source artwork is unavailable.');
    const template=document.createElementNS(NS,'g');
    for(const child of Array.from(body.children))template.appendChild(child.cloneNode(true));
    const wake=kind==='boat'?template.querySelector('[data-boat-wake]'):null;
    const wing=kind==='bird'?template.querySelector('path'):null;
    const firstX=wing?.getAttribute('d')?.match(/^M\s*(-?\d+(?:\.\d+)?)/u);
    const span=firstX?Math.abs(Number(firstX[1])):null;
    if(kind==='bird'&&(!span||!Number.isFinite(span)))throw new RangeError('The copied bird has no usable wing shape.');
    sanitize(template,svg);
    const wakeRoute=route(template,wake),wingRoute=route(template,wing);
    const source=relative(svg,node),sourceAnchor=worldPoint(svg,normalized);
    const artMatrix=kind==='boat'?mul(inverse(matrix(node.getScreenCTM())),matrix(body.getScreenCTM())):identity();
    const sourceScale=kind==='boat'?Math.hypot(artMatrix.a,artMatrix.b):1;
    if(!Number.isFinite(sourceScale)||sourceScale<=0)throw new RangeError('The source artwork scale is invalid.');
    const token=Object.freeze({assetId:++serial,kind});
    assets.set(token,{kind,template,wakeRoute,wingRoute,span,sourceScale,relative:mul(translate(-sourceAnchor.x,-sourceAnchor.y),source)});
    return token;
  }
  function apply(overrides={},positions=[]) {
    if(destroyed)throw new Error('Artwork snapshots have been destroyed.');
    const next=checkedOverrides(overrides),anchors=positionsOf(positions),wanted=new Set();
    // Validate geometry before replacing any currently visible artwork.
    const candidates=[];
    for(const [id,token] of Object.entries(next)) {
      const node=nodeFor(id),anchor=anchors.get(id);if(!node)continue;if(!anchor)throw new RangeError('A rendered anchor is required for copied artwork.');
      const asset=assets.get(token),body=asset.kind==='boat'?node.querySelector('[data-boat-art]'):asset.kind==='bird'?node.querySelector('[data-bird-art]'):node;
      if(!body)throw new RangeError('The destination artwork is unavailable.');
      let placement;
      if(asset.kind==='boat') {
        const current=mul(inverse(matrix(node.getScreenCTM())),matrix(body.getScreenCTM())),scale=Math.hypot(current.a,current.b);
        if(!Number.isFinite(scale)||scale<=0)throw new RangeError('The destination boat scale is invalid.');
        const ratio=asset.sourceScale/scale;placement={a:ratio,b:0,c:0,d:ratio,e:0,f:0};
      } else if(asset.kind==='bird')placement=identity();
      else {const destination=worldPoint(svg,anchor.point);placement=mul(inverse(relative(svg,node)),mul(translate(destination.x,destination.y),asset.relative));}
      candidates.push({id,node,body,asset,token,placement});wanted.add(node);
    }
    for(const [node,entry] of live) {
      if(!wanted.has(node)||!svg.contains(node)||entry.original.parentNode!==entry.body||entry.copy.parentNode!==entry.body){restore(entry);live.delete(node);}
    }
    for(const value of candidates) {
      const {id,node,body,asset,token,placement}=value;
      let entry=live.get(node);
      if(entry&&(entry.body!==body||entry.token!==token)){restore(entry);live.delete(node);entry=null;}
      if(!entry){
        const original=document.createElementNS(NS,'g');original.setAttribute('data-gesture-appearance-original','');original.setAttribute('display','none');
        const nativeWake=asset.kind==='boat'?body.querySelector('[data-boat-wake]'):null;
        const nativeWing=asset.kind==='bird'?body.querySelector('path'):null;
        for(const child of Array.from(body.childNodes))original.appendChild(child);
        const copy=asset.template.cloneNode(true);copy.setAttribute('data-gesture-appearance',id);
        copy.setAttribute('pointer-events','all');body.appendChild(original);body.appendChild(copy);
        entry={body,original,copy,token,nativeWake,nativeWing,copyWake:follow(copy,asset.wakeRoute),copyWing:follow(copy,asset.wingRoute)};live.set(node,entry);
      }
      const valueTransform=transform(placement);if(entry.copy.getAttribute('transform')!==valueTransform)entry.copy.setAttribute('transform',valueTransform);
      if(entry.nativeWake&&entry.copyWake){const opacity=entry.nativeWake.getAttribute('opacity');if(opacity===null)entry.copyWake.removeAttribute('opacity');else entry.copyWake.setAttribute('opacity',opacity);}
      if(entry.nativeWing&&entry.copyWing){
        const numbers=entry.nativeWing.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/gu)?.map(Number);
        if(numbers?.length===10&&numbers.every(Number.isFinite)){
          const h=numbers[3],span=asset.span;
          entry.copyWing.setAttribute('d',`M${fixed(-span)} 0Q${fixed(-span*.5)} ${fixed(h)} 0 0Q${fixed(span*.5)} ${fixed(h*.9)} ${fixed(span)} -1`);
        }
      }
    }
    applied=next;
  }
  function reset(){apply({},[]);return applied;}
  return Object.freeze({capture,apply,reset,has:token=>Boolean(token&&typeof token==='object'&&assets.has(token)),destroy(){if(destroyed)return;for(const entry of live.values())restore(entry);live.clear();applied=Object.freeze({});destroyed=true;}});
}
