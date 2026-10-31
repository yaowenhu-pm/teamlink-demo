import test from 'node:test';
import assert from 'node:assert/strict';
import {drawingPoints, ambientMotion} from '../web/motion-model.mjs';

test('a captured stroke stays bounded, round4 and preserves both endpoints and turns', () => {
  const raw = Array.from({length: 800}, (_, i) => ({x: i/799, y: .5+Math.sin(i/799*Math.PI*2)*.4}));
  const result = drawingPoints(raw);
  assert.equal(result.length, 40);
  assert.deepEqual(result[0], {x: 0, y: .5});
  assert.deepEqual(result.at(-1), {x: 1, y: .5});
  assert.ok(result.some(p => p.y > .89) && result.some(p => p.y < .11));
  assert.ok(result.every(p => Object.values(p).every(n => n >= 0 && n <= 1 && Number(n.toFixed(4)) === n)));
  assert.deepEqual(drawingPoints([{x: .123456, y: -2}, {x: .123456, y: -2}, {x: NaN, y: 1}, {x: 2, y: 1}]), [{x: .1235, y: 0}, {x: 1, y: 1}]);
});

test('ambient movement is deterministic, bounded and independent of leaf phase', () => {
  for (const kind of ['sun', 'boat', 'bird', 'water', 'cloud', 'rain']) {
    const a = ambientMotion(kind, 8, {wind: .4, index: 2});
    assert.deepEqual(ambientMotion(kind, 8, {wind: .4, index: 2}), a);
    assert.notDeepEqual(ambientMotion(kind, 9, {wind: .4, index: 2}), a);
    for (let t = 0; t <= 1000; t+=7) {
      const value = ambientMotion(kind, t, {wind: 1, index: 2});
      assert.ok(Math.abs(value.x) <= 100 && Math.abs(value.y) <= 55);
    }
  }
  assert.deepEqual(ambientMotion('mountain', 100), {x: 0, y: 0});
});

test('boats visibly sail within 3–5 seconds, even without wind, and turn without wrapping', () => {
  for(const wind of [0,.3,1]){
    assert.ok(Math.abs(ambientMotion('boat',3,{wind}).x)>=35,'three seconds must show substantial travel');
    assert.ok(Math.abs(ambientMotion('boat',5,{wind}).x)>=50,'five seconds must show sailing rather than rocking');
    let previous=ambientMotion('boat',0,{wind});
    for(let t=1/30;t<80;t+=1/30){
      const current=ambientMotion('boat',t,{wind});
      assert.ok(Math.abs(current.x)<=92);
      assert.ok(Math.abs(current.x-previous.x)<.8,'no frame can teleport at a wrap or turn');
      previous=current;
    }
  }
});

test('a boat near the camera edge sails into available water and never jumps outside its range', () => {
  const options={wind:.3,travelRange:{min:-100,max:20}};
  assert.ok(Math.abs(ambientMotion('boat',0,options).x)<1e-10,'saved anchor is the initial position');
  assert.ok(ambientMotion('boat',4,options).x < -25,'travel should favor the open side');
  for(let t=0;t<100;t+=.1){
    const motion=ambientMotion('boat',t,options);
    assert.ok(motion.x>=-82.20001&&motion.x<=20.00001);
    assert.deepEqual(ambientMotion('boat',t,options),motion,'holding time keeps every boat detail still');
  }
});

test('near and far water have visibly different current speeds and continuous traveling highlights', () => {
  const far=ambientMotion('water',3,{depth:.15}),middle=ambientMotion('water',3,{depth:.55}),near=ambientMotion('water',3,{depth:1});
  assert.ok(far.x>15&&middle.x>35&&near.x>60,'water must flow clearly within three seconds');
  assert.ok(near.x>far.x*3&&near.flow>far.flow*2,'perspective layers need different current rates');
  assert.notEqual(far.highlight,near.highlight,'highlights have separate phases');
  for(const depth of [.15,.55,1])for(const t of [0,3,10,30,100,1000]){
    const current=ambientMotion('water',t,{depth}),next=ambientMotion('water',t+1/60,{depth});
    assert.ok(Math.abs(next.x-current.x)<.5,'flow turns smoothly without texture jumps');
    assert.ok(next.flow>current.flow&&next.flow-current.flow<.4,'highlight phase scrolls continuously');
  }
});
