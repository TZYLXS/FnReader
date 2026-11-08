const fs=require('fs');
const { normalizeSource, searchSource } = require('../fnos-legado/app/server/src/books');
const arr=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
(async()=>{
  for (const raw of arr.slice(0, Number(process.argv[3]||40))) {
    const s=normalizeSource(raw);
    try { const b=await searchSource(s,'斗破',1); }
    catch(e){ if(/selector/i.test(e.message||'')) { console.log('###', s.bookSourceName, '|', e.message); console.log(e.stack.split('\n').slice(0,6).join('\n')); break; } }
  }
})();
