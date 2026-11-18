const { chromium } = require('playwright-core');
const BASE='https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host', SC='EVNPURXWC2';
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
async function getFrame(p){for(let i=0;i<40;i++){const f=p.frames().find(f=>f.url().indexOf('/zplab/')>=0);if(f)return f;await p.waitForTimeout(500);}return null;}
(async()=>{const b=await chromium.launch({executablePath:CHROME,args:['--no-sandbox']});const p=await b.newPage({viewport:{width:1680,height:1000}});
try{
await p.goto(BASE+'/app.html?sharecode='+SC,{waitUntil:'domcontentloaded',timeout:60000});await p.waitForTimeout(2500);
const u=await p.$('input[name=username],#username,#loginUser'),pw=await p.$('input[type=password]');
if(u&&pw){await u.fill('admin');await pw.fill('admin123');const btn=await p.$('button[type=submit],#loginBtn,.login-btn');if(btn)await btn.click();await p.waitForTimeout(4000);}
if(await p.$('input[type=password]'))await p.waitForTimeout(3000);
await p.waitForFunction(()=>(document.body.innerText||'').indexOf('快捷工具')>=0,{timeout:20000}).catch(()=>{});
await p.waitForTimeout(1000);
let fr=null;
for(let a=0;a<3&&!fr;a++){
  for(const el of await p.$$('a,button,li,span,div')){const t=(await (await el.getProperty('textContent')).jsonValue()||'').trim();if(t==='快捷工具'){await el.hover().catch(()=>{});break;}}
  await p.waitForTimeout(700);
  for(const el of await p.$$('a,button,li,span,div')){const t=(await (await el.getProperty('textContent')).jsonValue()||'').trim();if(t.indexOf('条码设计')>=0&&t.length<12){await el.click().catch(()=>{});break;}}
  await p.waitForTimeout(1500);fr=await getFrame(p);
  if(!fr){await p.evaluate(()=>{location.hash='#/tool_barcode';});fr=await getFrame(p);}
}
if(!fr){console.log('NO FRAME');await b.close();return;}
await p.waitForTimeout(4000);
const qr=await fr.$('text=二维码');if(qr){await qr.dblclick();await p.waitForTimeout(1500);}
const fields=await fr.evaluate(()=>{
  const inputs=Array.from(document.querySelectorAll('input:not([type=checkbox]),textarea')).map(e=>({tag:e.tagName,type:e.type||'',ph:e.placeholder||'',val:(e.value||'').slice(0,40),outer:e.outerHTML.slice(0,180),near:(e.parentElement&&e.parentElement.parentElement?e.parentElement.parentElement.innerText:'').slice(0,60).replace(/\n/g,'|')}));
  return inputs.slice(-15);
});
console.log('FIELDS=',JSON.stringify(fields).slice(0,2600));
// 点击 ZPL 页签看源码
const zplTab=await fr.$('text=ZPL');if(zplTab){await zplTab.click().catch(()=>{});await p.waitForTimeout(800);}
const zplText=await fr.evaluate(()=>{const tas=Array.from(document.querySelectorAll('textarea'));return tas.map(t=>(t.value||'').slice(0,400));});
console.log('ZPL_TEXT=',JSON.stringify(zplText).slice(0,1000));
}catch(e){console.log('ERR=',e.message)}await b.close();})();
