import express from "express";
import cors from "cors";
import pg from "pg";
const {Pool}=pg;
const app=express();
app.use(cors());
app.use(express.json());
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});

app.get("/health",async(_req,res)=>{try{await pool.query("select 1");res.json({ok:true,service:"stride-markets-api",database:"connected",mode:"simulation"})}catch(e){res.status(503).json({ok:false,database:"unavailable",mode:"simulation"})}});
app.get("/api/assets",async(_req,res)=>{try{const {rows}=await pool.query("select symbol,name,category,price,change_pct from assets where active=true order by symbol");res.json(rows)}catch(e){res.status(500).json({error:"database_error"})}});
app.get("/api/trades",async(req,res)=>{try{const limit=Math.min(Number(req.query.limit)||50,100);const {rows}=await pool.query("select id,side,symbol,amount,mode,created_at from trades order by created_at desc limit $1",[limit]);res.json(rows)}catch(e){res.status(500).json({error:"database_error"})}});
app.post("/api/trades",async(req,res)=>{const {side,symbol,amount}=req.body||{};if(!["BUY","SELL"].includes(side)||!symbol||!Number.isFinite(Number(amount))||Number(amount)<=0)return res.status(400).json({error:"invalid_trade"});try{const {rows}=await pool.query("insert into trades(side,symbol,amount,mode) values($1,$2,$3,'SIMULATION') returning id,side,symbol,amount,mode,created_at",[side,symbol,Number(amount)]);await pool.query("insert into activities(user_id,type,message) values(1,'TRADE',$1)",[`Simulated ${side} • ${symbol} • ${amount} USDT`]);res.status(201).json(rows[0])}catch(e){res.status(500).json({error:"database_error"})}});
app.get("/api/profile",async(_req,res)=>{try{const {rows}=await pool.query("select id,display_name,email from users where id=1");res.json(rows[0]||null)}catch(e){res.status(500).json({error:"database_error"})}});
app.get("/api/wallet",async(_req,res)=>{try{const {rows}=await pool.query("select asset,balance,updated_at from wallets where user_id=1 order by asset");res.json(rows)}catch(e){res.status(500).json({error:"database_error"})}});
app.get("/api/activities",async(req,res)=>{try{const limit=Math.min(Number(req.query.limit)||50,100);const {rows}=await pool.query("select id,type,message,created_at from activities where user_id=1 order by created_at desc limit $1",[limit]);res.json(rows)}catch(e){res.status(500).json({error:"database_error"})}});
app.get("/api/watchlist",async(_req,res)=>{try{const {rows}=await pool.query("select symbol from watchlist where user_id=1 order by created_at desc");res.json(rows.map(x=>x.symbol))}catch(e){res.status(500).json({error:"database_error"})}});
app.post("/api/watchlist",async(req,res)=>{const {symbol}=req.body||{};if(!symbol)return res.status(400).json({error:"invalid_symbol"});try{const q=await pool.query("select 1 from watchlist where user_id=1 and symbol=$1",[symbol]);if(q.rowCount)await pool.query("delete from watchlist where user_id=1 and symbol=$1",[symbol]);else await pool.query("insert into watchlist(user_id,symbol) values(1,$1)",[symbol]);const {rows}=await pool.query("select symbol from watchlist where user_id=1 order by created_at desc");res.json(rows.map(x=>x.symbol))}catch(e){res.status(500).json({error:"database_error"})}});

async function init(){
if(!process.env.DATABASE_URL){console.warn("DATABASE_URL is not configured");return;}
await pool.query(`
create table if not exists users(id bigserial primary key,display_name text not null default 'Daniel',email text unique,created_at timestamptz not null default now());
create table if not exists wallets(id bigserial primary key,user_id bigint not null references users(id) on delete cascade,balance numeric(30,10) not null default 0,asset text not null default 'USDT',updated_at timestamptz not null default now(),unique(user_id,asset));
create table if not exists assets(symbol text primary key,name text not null,category text not null,price numeric(30,10) not null default 0,change_pct numeric(12,6) not null default 0,active boolean not null default true,updated_at timestamptz not null default now());
create table if not exists trades(id bigserial primary key,side text not null check(side in ('BUY','SELL')),symbol text not null references assets(symbol),amount numeric(30,10) not null check(amount>0),mode text not null default 'SIMULATION',created_at timestamptz not null default now());
create table if not exists watchlist(user_id bigint not null references users(id) on delete cascade,symbol text not null references assets(symbol) on delete cascade,created_at timestamptz not null default now(),primary key(user_id,symbol));
create table if not exists activities(id bigserial primary key,user_id bigint references users(id) on delete cascade,type text not null,message text not null,created_at timestamptz not null default now());
`);
await pool.query("insert into users(id,display_name) values(1,'Daniel') on conflict(id) do nothing");
await pool.query("insert into wallets(user_id,balance,asset) values(1,0,'USDT') on conflict(user_id,asset) do nothing");
await pool.query(`insert into assets(symbol,name,category,price,change_pct) values
('DEX','Dex coin','Crypto',50.4319,1.11),('BTC','Bitcoin','Crypto',84842.10,-0.46),('ETH','Ethereum','Crypto',2681.34,-0.42),('USDT','Tether','Crypto',0.999890,0),('BNB','BNB','Crypto',779.72,0.74),('SOL','Solana','Crypto',202.10,1.23),('AAPL','Apple','Stocks',255.46,0.62),('TSLA','Tesla','Stocks',441.80,-0.31),('XAU','Gold','Commodities',3875.20,0.28),('XAG','Silver','Commodities',47.82,-0.12)
on conflict(symbol) do update set name=excluded.name,category=excluded.category,price=excluded.price,change_pct=excluded.change_pct,updated_at=now()`);
}
const port=process.env.PORT||10000;
init().then(()=>app.listen(port,()=>console.log("Stride Markets API listening on "+port))).catch(e=>{console.error(e);process.exit(1)});