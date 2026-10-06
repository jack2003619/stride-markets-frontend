const CACHE="stride-markets-v10";
self.addEventListener("install",e=>e.waitUntil(self.skipWaiting()));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("stride-markets-")&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const url=new URL(e.request.url);
  if(url.origin===self.location.origin && url.pathname.endsWith(".html")){
    e.respondWith(fetch(e.request,{cache:"no-store"}).then(async r=>{const h=await r.text();const injected=h.includes("trade-live.js")?h:h.replace("</body>","<script src=\"./trade-live.js?v=8\"></script></body>");const out=new Response(injected,{status:r.status,statusText:r.statusText,headers:r.headers});caches.open(CACHE).then(c=>c.put(e.request,out.clone()));return out}).catch(()=>caches.match(e.request)));
    return;
  }
  if(url.origin===self.location.origin && (url.pathname.endsWith(".js")||url.pathname.endsWith(".webmanifest"))){
    e.respondWith(fetch(e.request,{cache:"no-store"}).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(x=>x||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match("./"))));
});