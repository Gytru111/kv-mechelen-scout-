const CACHE='kvscout-v4';
const ASSETS=['./','./index.html','./manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  var url=new URL(e.request.url);
  if(url.pathname.indexOf('players.json')>=0||url.search.indexOf('players.json')>=0){
    e.respondWith(fetch(e.request).then(function(r){var c=r.clone();caches.open(CACHE).then(function(cache){cache.put(e.request,c);});return r;}).catch(function(){return caches.match(e.request);}));
  }else{
    e.respondWith(caches.match(e.request).then(function(r){return r||fetch(e.request);}));
  }
});
