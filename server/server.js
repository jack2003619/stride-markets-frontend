import express from "express";
import cors from "cors";
import pg from "pg";
const {Pool}=pg;
const app=express();
app.use(cors());
app.use(express.json());
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
app.get("/health",async(_req,res)=>{try{await pool.query("select 1");res.json({ok:true,service:"stride-markets-api",database:"connected",mode:"simulation"})}catch(e){res.status(503).json({ok:false,database:"unavailable"})}});
app.get("/api/assets",async(_req,res)=>{try{const {rows}=await pool.query("select symbol,name,category,price,change_pct from assets where active=true order by symbol");res.json(rows)}catch(e){res.status(500).json({error:"database_error"})}});
app.get("/api/trades",async(req,res)=>{try{const limit=Math.min(Number(req.query.limit)||50,100);const {rows}=await pool.query("select id,side,symbol,amount,created_at from trades order by created_at desc limit $1",[limit]);res.json(rows)}catch(e){res.status(500).json({error:"database_error"})}});
app.post("/api/trades",async(req,res)=>{const {side,symbol,amount}=req.body;if(!["BUY","SELL"].includes(side)||!symbol||!Number.isFinite(Number(amount))||Number(amount)<=0)return res.status(400).json({error:"invalid_trade"});try{const {rows}=await pool.query("insert into trades(side,symbol,amount,mode) values($1,$2,$3,'SIMULATION') returning id,side,symbol,amount,created_at",[side,symbol,Number(amount)]);res.status(201).json(rows[0])}catch(e){res.status(500).json({error:"database_error"})}});
async function init(){
if(!process.env.DATABASE_URL) return;
await pool.query(`create table if not exists assets(symbol text primary key,name text not null,category text not null,price numeric(30,10) not null default 0,change_pct numeric(12,6) not null default 0,active boolean not null default true,updated_at timestamptz not null default now());
create table if not exists trades(id bigserial primary key,side text not null check(side in ('BUY','SELL')),symbol text not null references assets(symbol),amount numeric(30,10) not null check(amount>0),mode text not null default 'SIMULATION',created_at timestamptz not null default now());`);
await pool.query(`insert into assets(symbol,name,category,price,change_pct) values
('DEX','Dex coin','Crypto',50.4319,1.11),('BTC','Bitcoin','Crypto',84842.10,-0.46),('ETH','Ethereum','Crypto',2681.34,-0.42),('USDT','Tether','Crypto',0.999890,0),('BNB','BNB','Crypto',779.72,0.74),('SOL','Solana','Crypto',202.10,1.23),('AAPL','Apple','Stocks',255.46,0.62),('TSLA','Tesla','Stocks',441.80,-0.31),('XAU','Gold','Commodities',3875.20,0.28),('XAG','Silver','Commodities',47.82,-0.12)
on conflict(symbol) do update set name=excluded.name,category=excluded.category,price=excluded.price,change_pct=excluded.change_pct,updated_at=now()`);
}
const port=process.env.PORT||10000;
init().then(()=>app.listen(port,()=>console.log("Stride Markets API listening on "+port))).catch(e=>{console.error(e);process.exit(1)});