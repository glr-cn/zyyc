const { chromium } = require('playwright-core');
const BASE='https://wbapp-asi4jzhsb1qg5dmqbgcruy.app.workbuddy.host', SC='EVNPURXWC2';
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
(async()=>{const b=await chromium.launch({executablePath:CHROME,args:['--no-sandbox']});const p=await b.newPage({viewport:{width:1680,height:1000}});
const bad=[];p.on('response',r=>{if(r.url().indexOf('/zplab/')>=0&&r.status()>=400)bad.push(r.status()+' '+r.url());});
try{
await p.goto(BASE+'/app.html?sharecode='+SC,{waitUntil:'domcontentloaded',timeout:60000});await p.waitForTimeout(2500);
const u=await p.$('input[name=username],#username,#loginUser'),pw=await p.$('input[type=password]');
if(u&&pw){await u.fill('admin');await pw.fill('admin123');const btn=await p.$('button[type=submit],#loginBtn,.login-btn');if(btn)await btn.click();await p.waitForTimeout(4000);}
await p.evaluate(()=>{location.hash='#/tool_barcode';});await p.waitForTimeout(5000);
console.log('frameCount=',p.frames().length);
const fr=p.frames().find(f=>f.url().indexOf('/zplab/')>=0);
console.log('zplabFrameUrl=',fr?fr.url():'NONE');
if(fr){
const txt=await fr.evaluate(()=>document.body.innerText||'');
console.log('FRAME_TEXT=',txt.slice(0,1200).replace(/\n/g,'|'));
const info=await fr.evaluate(()=>{
  const all=Array.from(document.querySelectorAll('*'));
  const hits=all.filter(e=>(e.textContent||'').trim()==='Code 128').slice(0,6).map(e=>({tag:e.tagName,cls:e.className&&String(e.className).slice(0,80),outer:e.outerHTML.slice(0,200)}));
  return {rootChildren:document.getElementById('root')?document.getElementById('root').children.length:0,hits};
});
console.log('INFO=',JSON.stringify(info).slice(0,1500));
}
console.log('BAD_ZPLAB=',JSON.stringify(bad));
}catch(e){console.log('ERR=',e.message)}await b.close();})();
