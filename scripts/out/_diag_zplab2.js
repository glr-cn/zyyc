const { chromium } = require('playwright-core');
const BASE='https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host', SC='EVNPURXWC2';
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
async function getFrame(p){for(let i=0;i<40;i++){const f=p.frames().find(f=>f.url().indexOf('/zplab/')>=0);if(f)return f;await p.waitForTimeout(500);}return null;}
(async()=>{const b=await chromium.launch({executablePath:CHROME,args:['--no-sandbox']});const p=await b.newPage({viewport:{width:1680,height:1000}});
try{
await p.goto(BASE+'/app.html?sharecode='+SC,{waitUntil:'domcontentloaded',timeout:60000});await p.waitForTimeout(2500);
const u=await p.$('input[name=username],#username,#loginUser'),pw=await p.$('input[type=password]');
if(u&&pw){await u.fill('admin');await pw.fill('admin123');const btn=await p.$('button[type=submit],#loginBtn,.login-btn');if(btn)await btn.click();await p.waitForTimeout(4000);}
await p.evaluate(()=>{location.hash='#/tool_barcode';});
const fr=await getFrame(p);
console.log('frameFound=',!!fr, fr?fr.url():'');
if(!fr){console.log('FRAME_TEXT_NOW=',(await p.evaluate(()=>document.body.innerText||'')).slice(0,200));await b.close();return;}
await p.waitForTimeout(4000);
const before=await fr.evaluate(()=>document.body.innerText);
console.log('beforeLen=',before.length,'hasCode128=',before.indexOf('Code 128')>=0);
const c128=await fr.$('text=Code 128');
console.log('c128Found=',!!c128);
if(c128){await c128.dblclick();await p.waitForTimeout(1500);}
const after=await fr.evaluate(()=>document.body.innerText);
console.log('afterLen=',after.length);
const dump=await fr.evaluate(()=>{
  let sel=null,propsText='';
  // 属性面板通常含"格式/预设/宽度"等
  const body=document.body.innerText;
  return {canvasCount:document.querySelectorAll('canvas').length,svgCount:document.querySelectorAll('svg').length,
    hasZpl:body.indexOf('ZPL')>=0, tail:body.slice(-700).replace(/\n/g,'|')};
});
console.log('AFTER_DBL=',JSON.stringify(dump).slice(0,1600));
// 尝试点击画布中的条码（canvas 或 svg 附近）
const clickable=await fr.evaluate(()=>{
  // 找到可能代表画布中条码的元素：aria-label / title / data-* 含 barcode/code
  const els=Array.from(document.querySelectorAll('[class*="canvas" i],[class*="stage" i],[class*="label" i],canvas,svg')).slice(0,20);
  return els.map(e=>({tag:e.tagName,cls:String(e.className||'').slice(0,60),rect:(()=>{const r=e.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];})()}));
});
console.log('CLICKABLES=',JSON.stringify(clickable).slice(0,1600));
}catch(e){console.log('ERR=',e.message)}await b.close();})();
