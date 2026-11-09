import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { readFile, writeFile } from 'node:fs/promises'
const TOKEN=(await readFile('test/env/browser-client-token-4149','utf8')).trim()
const srv=spawn('python3',['-m','http.server','8915','--directory','.'],{stdio:'ignore'})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const port=9951
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,'--user-data-dir=/tmp/chrome-s5-'+Date.now(),'--window-size=1000,800','about:blank'],{stdio:'ignore'})
let t;for(let i=0;i<80;i++){try{const l=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1200)})).json();t=l.find(x=>x.type==='page');if(t)break}catch{}await sleep(200)}
const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r))
let seq=0;const p=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id&&p.has(m.id)){p.get(m.id)(m.result??m);p.delete(m.id)}})
const send=(method,params={})=>new Promise(res=>{const id=++seq;p.set(id,res);ws.send(JSON.stringify({id,method,params}))})
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r?.result?.value}
await send('Page.enable');await send('Runtime.enable')
await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]})
await send('Page.navigate',{url:`http://127.0.0.1:8915/test/env/shell-harness.html?token=${TOKEN}&base=http://127.0.0.1:4149`})
await sleep(2500)
await ev(`document.documentElement.style.background='#202124';document.body.style.background='#202124'`)
await ev(`window.__emit({type:'dsh:open',mode:'minimal'})`)
await sleep(9000)
const s=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/s5-dark.png',Buffer.from(s.data,'base64'))
chrome.kill();srv.kill();ws.close();process.exit(0)
