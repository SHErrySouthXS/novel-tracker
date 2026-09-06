const h=require('http'),f=require('fs'),p=require('path');
const root=__dirname;
const mime={'html':'text/html;charset=utf-8','json':'application/json;charset=utf-8','js':'text/javascript','css':'text/css','svg':'image/svg+xml','png':'image/png','ico':'image/x-icon'};
h.createServer((q,r)=>{
  let u=q.url.split('?')[0];
  if(u==='/')u='/index.html';
  const fp=p.join(root,u);
  const ext=p.extname(fp).slice(1);
  f.readFile(fp,(e,d)=>{
    if(e){r.writeHead(404);r.end('Not found');return;}
    r.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream'});
    r.end(d);
  });
}).listen(3847,()=>console.log('Server: http://localhost:3847'));
