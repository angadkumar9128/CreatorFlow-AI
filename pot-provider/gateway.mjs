import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 4416);
const USER = process.env.POT_PROVIDER_USER || "creatorflow";
const PASSWORD = process.env.POT_PROVIDER_PASSWORD || "";
const MAX_BODY = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 45_000;

if (!PASSWORD && process.env.ALLOW_UNAUTHENTICATED !== "1") {
  console.error("[gateway] POT_PROVIDER_PASSWORD is not set; refusing to start.");
  process.exit(1);
}

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest();
const expected = sha(`${USER}:${PASSWORD}`);

function authorized(req) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  return crypto.timingSafeEqual(sha(decoded), expected);
}

function send(res,status,payload){
  const body=JSON.stringify(payload);
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":Buffer.byteLength(body)});
  res.end(body);
}

function proxyToUpstream(req,res,body){
  const upstream=http.request({host:"127.0.0.1",port:UPSTREAM_PORT,method:req.method,path:req.url,timeout:UPSTREAM_TIMEOUT_MS,
    headers:{"content-type":req.headers["content-type"]||"application/json","content-length":body?Buffer.byteLength(body):0}},(up)=>{
      res.writeHead(up.statusCode||502,{"Content-Type":up.headers["content-type"]||"application/json","Cache-Control":"no-store"});
      up.pipe(res);
    });
  upstream.on("timeout",()=>upstream.destroy(new Error("upstream timeout")));
  upstream.on("error",(err)=>{if(!res.headersSent)send(res,502,{error:"PO-token server unavailable: "+err.message});else res.destroy();});
  if(body)upstream.write(body);
  upstream.end();
}

const server=http.createServer((req,res)=>{
  const path=(req.url||"").split("?")[0];
  if(req.method==="GET"&&path==="/healthz"){
    const probe=http.get({host:"127.0.0.1",port:UPSTREAM_PORT,path:"/ping",timeout:3000},(up)=>{
      up.resume(); send(res,up.statusCode===200?200:503,{ok:up.statusCode===200});
    });
    probe.on("timeout",()=>probe.destroy());
    probe.on("error",()=>send(res,503,{ok:false}));
    return;
  }
  if(!authorized(req)){res.setHeader("WWW-Authenticate",'Basic realm="pot-provider"');return send(res,401,{error:"Unauthorized"});}
  const allowed=(req.method==="GET"&&path==="/ping")||(req.method==="POST"&&path==="/get_pot");
  if(!allowed)return send(res,404,{error:"Not found"});
  if(req.method==="GET")return proxyToUpstream(req,res,null);
  const chunks=[]; let size=0;
  req.on("data",(chunk)=>{size+=chunk.length;if(size>MAX_BODY){send(res,413,{error:"Request too large"});req.destroy();return;}chunks.push(chunk);});
  req.on("end",()=>{if(!res.writableEnded)proxyToUpstream(req,res,Buffer.concat(chunks));});
});

const child=spawn(process.execPath,["build/main.js","--host","127.0.0.1","--port",String(UPSTREAM_PORT)],{stdio:"inherit",cwd:process.env.UPSTREAM_DIR||"/app"});
child.on("exit",(code,signal)=>{console.error(`[gateway] upstream exited (code=${code} signal=${signal}); shutting down`);process.exit(code||1);});
server.listen(PORT,"0.0.0.0",()=>console.log(`[gateway] listening on :${PORT} (auth ${PASSWORD?"on":"OFF"})`));
for(const sig of ["SIGTERM","SIGINT"]){process.on(sig,()=>{server.close();child.kill(sig);setTimeout(()=>process.exit(0),3000).unref();});}
