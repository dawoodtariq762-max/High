import { chromium } from 'playwright';
const B='http://127.0.0.1:4901';
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1440,height:900}});
await ctx.route('**/*', r=>r.continue());
const p=await ctx.newPage();
const bad=[];
p.on('response', r=>{ if(/\.(png|svg)/.test(r.url()) && r.status()>=400) bad.push(r.status()+' '+r.url()); });

const PAGES=['/panel-login','/management-login.html','/payment-login.html','/panel-sharing-login.html','/management.html'];
for(const u of PAGES){
  await p.goto(B+u+'?cb='+Date.now(),{waitUntil:'networkidle'});
  await p.waitForTimeout(400);
  const info=await p.evaluate(()=>{
    const imgs=[...document.querySelectorAll('img')].filter(i=>/zoom-logo|favicon/i.test(i.src));
    return imgs.map(i=>({
      file:(i.getAttribute('src')||'').split('/').pop().split('?')[0],
      loaded:i.complete && i.naturalWidth>0,
      nat:i.naturalWidth+'x'+i.naturalHeight,
      shown:Math.round(i.getBoundingClientRect().width)+'x'+Math.round(i.getBoundingClientRect().height),
      vis:i.getBoundingClientRect().width>0
    }));
  });
  console.log('  '+u);
  info.forEach(x=>console.log('     %s loaded=%s natural=%s rendered=%s visible=%s',
    x.file.padEnd(28), x.loaded, x.nat.padEnd(10), x.shown.padEnd(10), x.vis));
}
// admin panel logo
await p.goto(B+'/panel-login?cb='+Date.now(),{waitUntil:'networkidle'});
await p.fill('#username','vibepk'); await p.fill('#password','vibepk123');
const c=await p.textContent('#captchaText');
await p.fill('#captcha', String(eval(c.replace('+','+'))));
await p.click('button[type=submit]'); await p.waitForTimeout(2200);
const adm=await p.evaluate(()=>{
  const imgs=[...document.querySelectorAll('img')].filter(i=>/zoom-logo/i.test(i.src));
  return imgs.map(i=>({file:(i.getAttribute('src')||'').split('/').pop().split('?')[0],
    loaded:i.complete&&i.naturalWidth>0, nat:i.naturalWidth+'x'+i.naturalHeight,
    shown:Math.round(i.getBoundingClientRect().width)+'x'+Math.round(i.getBoundingClientRect().height)}));
});
console.log('  /admin/dashboard');
adm.forEach(x=>console.log('     %s loaded=%s natural=%s rendered=%s',x.file.padEnd(28),x.loaded,x.nat.padEnd(10),x.shown.padEnd(10)));
console.log('\n  failed image requests: '+(bad.length?bad.join(', '):'none'));
await b.close();
