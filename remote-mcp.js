/** Optional authenticated Streamable HTTP MCP endpoint.
 *
 * Runs independently of the local Dashboard/JSON API. Each POST gets a fresh
 * stateless MCP server/transport; persistent nutrition state remains in SQLite.
 * No MCP session IDs are issued or accepted as authority.
 */
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const MAX_ACTIVE = 16;
const isTrue = v => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
const csv = str => String(str ?? '').split(',').map(x => x.trim()).filter(Boolean);
const compare = (a,b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
};
function hostname(raw) {
  if (!raw || /[/\\@\s]/.test(raw)) return null;
  try {
    const url=new URL('http://' + raw);
    return url.hostname.toLowerCase();
  } catch { return null; }
}
function allowedOrigin(origin, allow) {
  if (!origin) return true; // native MCP HTTP clients often omit Origin
  if (origin === 'null') return false;
  try {
    const url = new URL(origin);
    return !url.username && !url.password && url.pathname==='/' && !url.search && !url.hash &&
      (url.protocol==='https:' || url.protocol==='http:') && allow.has(url.origin);
  } catch {return false;}
}
/**
 * @param {{makeServer:()=>import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
 *   config?:NodeJS.ProcessEnv, log?:(...args:any[])=>void}} opts
 */
export function startRemoteMcp({makeServer,config=process.env,log=console.error}) {
  if (!isTrue(config.MCP_HTTP_ENABLED)) return null;
  const token=config.MCP_HTTP_TOKEN;
  if (typeof token!=='string' || Buffer.byteLength(token)<32) {
    throw new Error('MCP_HTTP_TOKEN must be a secret of at least 32 bytes when remote MCP is enabled');
  }
  const host=config.MCP_HTTP_HOST || '127.0.0.1';
  const port=Number(config.MCP_HTTP_PORT || 3457);
  if (!Number.isInteger(port)||port<0||port>65535) throw new Error('Invalid MCP_HTTP_PORT');
  const hosts=new Set([...LOCAL_HOSTS,...csv(config.MCP_ALLOWED_HOSTS).map(hostname)]);
  if (hosts.has(null)) throw new Error('Invalid MCP_ALLOWED_HOSTS');
  const origins=new Set(csv(config.MCP_ALLOWED_ORIGINS).map(x=>{
    try {const url=new URL(x);return url.origin===x?x:null;}catch{return null;}
  }));
  if (origins.has(null)) throw new Error('Invalid MCP_ALLOWED_ORIGINS; use full origins without trailing slash');

  const app=express();
  app.disable('x-powered-by');
  app.use(express.json({limit:'128kb',type:'application/json'}));
  let active=0;
  app.use('/mcp',(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    const currentHost=hostname(req.get('Host'));
    if (!currentHost || !hosts.has(currentHost)) return res.status(403).json({error:'MCP Host denied'});
    if (!allowedOrigin(req.get('Origin'),origins)) return res.status(403).json({error:'MCP Origin denied'});
    const bearer=req.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!compare(bearer,token)) {
      res.setHeader('WWW-Authenticate','Bearer realm="nutrition-mcp"');
      return res.status(401).json({error:'MCP authentication required'});
    }
    next();
  });
  app.post('/mcp',async(req,res)=>{
    if (active>=MAX_ACTIVE) return res.status(503).json({error:'MCP busy'});
    ++active;
    let mcp;
    try {
      mcp=makeServer();
      const transport=new StreamableHTTPServerTransport({
        sessionIdGenerator:undefined,
        enableJsonResponse:true,
        maxRequestBodySize:128*1024
      });
      await mcp.connect(transport);
      await transport.handleRequest(req,res,req.body);
    }catch(e){
      log('Remote MCP request failed:',e?.message || 'unknown error');
      if(!res.headersSent) res.status(500).json({error:'MCP request failed'});
      else if(!res.writableEnded)res.end();
    }finally{
      if(mcp) await mcp.close().catch(()=>{});
      --active;
    }
  });
  // Stateless mode does not offer GET subscriptions or DELETE session teardown.
  app.get('/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
  app.delete('/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
  app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST').end());
  app.use((err,_req,res,_next)=>{
    if(!res.headersSent)res.status(err?.status===413?413:400).json({error:'Invalid MCP HTTP request'});
  });
  const server=app.listen(port,host,()=>{
    log(`Remote MCP enabled at ${host}:${server.address().port}/mcp (bearer auth, stateless)`);
  });
  server.on('error',e=>log('Remote MCP listener failed:',e.message));
  return server;
}
