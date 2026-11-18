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
const top=await fr.evaluate(()=>{const t=document.body.innerText||'';return{hasLangWord:/语言|Language|English|简体/.test(t.slice(0,400)),selects:document.querySelectorAll('select').length,head:t.slice(0,80).replace(/\n/g,'|')};});
console.log('TOP=',JSON.stringify(top));
const body=await fr.evaluate(()=>document.body.innerText||'');
console.log('HAS_CODE11=',body.indexOf('Code 11')>=0,'HAS_旧式=',body.indexOf('旧式')>=0);
const qr=await fr.$('text=二维码');
console.log('qrFound=',!!qr);
if(qr){await qr.dblclick();await p.waitForTimeout(1600);}
const after=await fr.evaluate(()=>document.body.innerText||'');
console.log('AFTER_QR=',after.slice(-700).replace(/\n/g,'|'));
const cbs=await fr.evaluate(()=>{const els=Array.from(document.querySelectorAll('input[type=checkbox],button[role=switch],[role=checkbox]'));return els.map(e=>({tag:e.tagName,outer:e.outerHTML.slice(0,160),parentText:(e.parentElement?e.parentElement.innerText:'').slice(0,60).replace(/\n/g,'|')})).slice(-20);});
console.log('CHECKBOXES=',JSON.stringify(cbs).slice(0,2000));
}catch(e){console.log('ERR=',e.message)}await b.close();})();
