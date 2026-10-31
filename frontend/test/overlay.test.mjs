import test from 'node:test';
import assert from 'node:assert/strict';
import {boxToRect} from '../overlay.js';
test('normalised corner box becomes image coordinates',()=>{
 assert.deepEqual(boxToRect([.25,.1,.5,.6],640,480),{x:160,y:48,width:160,height:240});
 assert.deepEqual(boxToRect([0,0,1,1],1200,800),{x:0,y:0,width:1200,height:800});
});
test('missing, malformed and unsupported box coordinates produce no outline',()=>{
 for(const box of [null,undefined,[],[0,0,1],[.5,.5,.4,.8],[0,0,0,1],[-.1,0,.5,.5],[0,0,2,1],[0,0,NaN,1],[0,0,'1',1],{x:0,y:0,width:1,height:1}])assert.equal(boxToRect(box,640,480),null);
 for(const [w,h] of [[0,480],[640,0],[NaN,480],[-1,480]])assert.equal(boxToRect([0,0,1,1],w,h),null);
});
