import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { SignJWT, jwtVerify } from 'jose';
import crypto from 'node:crypto';
import { migrate, seedIfEmpty, pool } from './db.js';
import { dashboard, transactions } from './dashboard.js';
import { authenticate, seedAdmin } from './auth.js';

const app=Fastify({ logger:true, trustProxy:true, bodyLimit:1_000_000 });
const origins=(process.env.ALLOWED_ORIGINS||'http://localhost:5173').split(',').map(x=>x.trim());
await app.register(cors,{ origin:(origin,cb)=>cb(null,!origin||origins.includes(origin)), methods:['GET','POST'] });
await app.register(helmet,{ contentSecurityPolicy:false });
await app.register(rateLimit,{ max:120,timeWindow:'1 minute' });
const secret=new TextEncoder().encode(process.env.JWT_SECRET || 'development-secret-change-me');

async function auth(req,reply){
  const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');
  if(!token) return reply.code(401).send({error:'Não autenticado'});
  try{ req.user=(await jwtVerify(token,secret,{issuer:'dashbv'})).payload; }catch{return reply.code(401).send({error:'Sessão inválida'});}
}

app.get('/api/health',async()=>{ await pool.query('SELECT 1'); return {status:'ok',time:new Date().toISOString()}; });
app.post('/api/auth/login',{config:{rateLimit:{max:8,timeWindow:'15 minutes'}}},async(req,reply)=>{
  const {email,password}=req.body||{};
  const user=await authenticate(email,password);
  if(!user) return reply.code(401).send({error:'Credenciais inválidas'});
  const token=await new SignJWT({sub:String(user.id),email:user.email,role:user.role}).setProtectedHeader({alg:'HS256'}).setIssuer('dashbv').setIssuedAt().setExpirationTime('8h').sign(secret);
  return {token,expiresIn:28800};
});
app.get('/api/dashboard',{preHandler:auth},async req=>dashboard(req.query));
app.get('/api/transactions',{preHandler:auth},async req=>transactions(req.query));
app.get('/api/meta',{preHandler:auth},async()=>{
  const [funds,categories,lastImport]=await Promise.all([
    pool.query('SELECT DISTINCT fund FROM transactions ORDER BY fund'),pool.query('SELECT DISTINCT category FROM transactions ORDER BY category'),
    pool.query('SELECT * FROM import_runs ORDER BY started_at DESC LIMIT 1')]);
  return {funds:funds.rows.map(x=>x.fund),categories:categories.rows.map(x=>x.category),lastImport:lastImport.rows[0]||null};
});
app.post('/api/insights',{preHandler:auth,config:{rateLimit:{max:10,timeWindow:'1 hour'}}},async(req,reply)=>{
  if(!process.env.GROQ_API_KEY) return reply.code(503).send({error:'Agente Groq ainda não configurado'});
  const data=await dashboard(req.body||{}); const cacheKey=crypto.createHash('sha256').update(JSON.stringify({q:req.body,data})).digest('hex');
  const cached=await pool.query("SELECT content FROM insight_cache WHERE cache_key=$1 AND created_at > now()-interval '12 hours'",[cacheKey]);
  if(cached.rowCount) return cached.rows[0].content;
  const prompt=`Você é um analista financeiro de condomínio. Analise somente os agregados JSON fornecidos. Responda em português, sem inventar causas. Retorne JSON com summary (string), highlights (até 4 strings), risks (até 3 strings) e actions (até 3 strings). Dados: ${JSON.stringify(data)}`;
  const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.GROQ_MODEL||'llama-3.3-70b-versatile',messages:[{role:'user',content:prompt}],response_format:{type:'json_object'},temperature:.2,max_completion_tokens:900})});
  if(!response.ok){app.log.error({status:response.status},'Groq failed');return reply.code(502).send({error:'Falha temporária no agente'});}
  const raw=await response.json(); const content=JSON.parse(raw.choices[0].message.content);
  await pool.query('INSERT INTO insight_cache(cache_key,content) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET content=excluded.content,created_at=now()',[cacheKey,content]);
  return content;
});

await migrate(); await seedAdmin(); await seedIfEmpty();
await app.listen({host:'0.0.0.0',port:Number(process.env.PORT)||3000});
