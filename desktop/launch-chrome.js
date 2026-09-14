const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const root = __dirname;
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.wav':'audio/wav','.json':'application/json'};
const server = http.createServer((req,res)=>{
  let pathname = decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  if(pathname === '/') pathname='/desktop.html';
  const file = path.normalize(path.join(root, pathname));
  if(!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, {'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
  fs.createReadStream(file).pipe(res);
});
server.listen(0,'127.0.0.1',()=>{
  const port=server.address().port;
  const url=`http://127.0.0.1:${port}/`;
  const chrome = process.env.CHROME_PATH || 'chrome.exe';
  execFile(chrome,[`--app=${url}`],err=>{
    if(err) console.error('Chrome could not be started:',err.message);
    console.log(`Luna Chrome UI: ${url}`);
  });
});
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
