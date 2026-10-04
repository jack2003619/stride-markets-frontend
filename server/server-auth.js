import { mountMarketEngine } from "./market-engine.js";
import express from "express";
import cors from "cors";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
const {Pool}=pg, app=express();
app.use(cors()); app.use(express.json());
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
const JWT_SECRET=process.env.JWT_SECRET;
const token=(u)=>{if(!JWT_SECRET)throw new Error("auth_not_configured");return jwt.sign({sub:String(u.id),role:u.role,email:u.email},JWT_SECRET,{expiresIn:"30d"})};
function auth(req,res,next){if(!JWT_SECRET)return res.status(503).json({error:"auth_not_configured"});try{const t=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");const p=jwt.verify(t,JWT_SECRET);req.user={id:Number(p.sub),role:p.role,email:p.email};next()}catch{res.status(401).json({error:"unauthorized"})}}
function admin(req,res,next){if(!["admin","superadmin"].includes(req.user?.role))return res.status(403).json({error:"admin_only"});next()}
function superadmin(req,res,next){if(req.user?.role!=="superadmin")return res.status(403).json({error:"superadmin_only"});next()}

app.get("/health",async(_req,res)=>{try{await pool.query("select 1");res.json({ok:true,mode:"simulation",database:"connected"})}catch{res.status(503).json({ok:false,mode:"simulation",database:"unavailable"})}});

app.post("/api/auth/register",async(req,res)=>{
 const {displayName,email,password,firstName,lastName,phone,country,dateOfBirth}=req.body||{};
 if(!displayName?.trim()||!email?.trim()||!password||password.length<8)return res.status(400).json({error:"display_name_email_and_8_char_password_required"});
 const safePhone=String(phone||"").trim().slice(0,40), safeCountry=String(country||"").trim().slice(0,80), safeDob=String(dateOfBirth||"").trim().slice(0,20), safeFirst=String(firstName||"").trim().slice(0,80), safeLast=String(lastName||"").trim().slice(0,80);
 try{const e=email.trim().toLowerCase();if((await pool.query("select 1 from users where email=$1",[e])).rowCount)return res.status(409).json({error:"email_already_registered"});
 const h=await bcrypt.hash(password,12);
 const {rows}=await pool.query("insert into users(display_name,email,password_hash,role,first_name,last_name,phone,country,date_of_birth) values($1,$2,$3,'user',$4,$5,$6,$7,$8) returning id,display_name,email,role,first_name,last_name,phone,country,date_of_birth",[displayName.trim(),e,h,safeFirst,safeLast,safePhone,safeCountry,safeDob||null]);
 await pool.query("insert into wallets(user_id,balance,asset) values($1,0,'USDT') on conflict(user_id,asset) do nothing",[rows[0].id]);
 await pool.query("insert into simulation_controls(user_id,mode,pnl_percent,enabled) values($1,'RANDOM',5,true) on conflict(user_id) do nothing",[rows[0].id]);
 res.status(201).json({user:rows[0],token:token(rows[0])});
 }catch(e){console.error(e);res.status(500).json({error:"database_error"})}
});

app.post("/api/auth/login",async(req,res)=>{
 const {email,password}=req.body||{};if(!email?.trim()||!password)return res.status(400).json({error:"email_and_password_required"});
 try{if(!JWT_SECRET)return res.status(503).json({error:"auth_not_configured"});const e=email.trim().toLowerCase();const {rows}=await pool.query("select id,display_name,email,role,password_hash from users where lower(email)=lower($1)",[e]);const u=rows[0];
 if(!u||!(await bcrypt.compare(password,u.password_hash||"")))return res.status(401).json({error:"invalid_credentials"});
 const safe={id:u.id,display_name:u.display_name,email:u.email,role:u.role};res.json({user:safe,token:token(safe)});
 }catch(e){console.error("login_error",e);res.status(500).json({error:"database_error"})}
});
app.get("/api/auth/me",auth,async(req,res)=>{const {rows}=await pool.query("select id,display_name,email,role,created_at from users where id=$1",[req.user.id]);res.json(rows[0]||null)});

app.get("/api/profile",auth,async(req,res)=>{const {rows}=await pool.query("select id,display_name,email,role,first_name,last_name,phone,country,date_of_birth,created_at from users where id=$1",[req.user.id]);res.json(rows[0]||null)});
app.patch("/api/profile",auth,async(req,res)=>{const {displayName,firstName,lastName,phone,country,dateOfBirth}=req.body||{};try{const {rows}=await pool.query("update users set display_name=coalesce(nullif(trim($1),''),display_name),first_name=coalesce($2,first_name),last_name=coalesce($3,last_name),phone=coalesce($4,phone),country=coalesce($5,country),date_of_birth=coalesce(nullif($6,''),date_of_birth) where id=$7 returning id,display_name,email,role,first_name,last_name,phone,country,date_of_birth,created_at",[displayName,firstName,lastName,phone,country,dateOfBirth,req.user.id]);res.json(rows[0]||null)}catch(e){console.error(e);res.status(500).json({error:"database_error"})}});
app.get("/api/wallet",auth,async(req,res)=>{const {rows}=await pool.query("select asset,balance,updated_at from wallets where user_id=$1 order by asset",[req.user.id]);res.json(rows)});
app.get("/api/assets",async(_req,res)=>{const {rows}=await pool.query("select symbol,name,category,price,change_pct from assets where active=true order by symbol");res.json(rows)});

app.get("/api/watchlist",auth,async(req,res)=>{const {rows}=await pool.query("select symbol from watchlist where user_id=$1 order by created_at desc",[req.user.id]);res.json(rows.map(x=>x.symbol))});
app.post("/api/watchlist",auth,async(req,res)=>{const {symbol}=req.body||{};if(!symbol)return res.status(400).json({error:"invalid_symbol"});const q=await pool.query("select 1 from watchlist where user_id=$1 and symbol=$2",[req.user.id,symbol]);if(q.rowCount)await pool.query("delete from watchlist where user_id=$1 and symbol=$2",[req.user.id,symbol]);else await pool.query("insert into watchlist(user_id,symbol) values($1,$2)",[req.user.id,symbol]);const {rows}=await pool.query("select symbol from watchlist where user_id=$1 order by created_at desc",[req.user.id]);res.json(rows.map(x=>x.symbol))});

app.post("/api/trades",auth,async(req,res)=>{
 const {side,symbol,amount}=req.body||{};if(!["BUY","SELL"].includes(side)||!symbol||!Number.isFinite(Number(amount))||Number(amount)<=0)return res.status(400).json({error:"invalid_trade"});
 try{if(!(await pool.query("select 1 from assets where symbol=$1 and active=true",[symbol])).rowCount)return res.status(400).json({error:"invalid_asset"});
 const c=(await pool.query("select mode,pnl_percent,enabled from simulation_controls where user_id=$1",[req.user.id])).rows[0]||{mode:"RANDOM",pnl_percent:5,enabled:true};
 let p=0;if(c.enabled){if(c.mode==="PROFIT")p=Math.abs(Number(c.pnl_percent));else if(c.mode==="LOSS")p=-Math.abs(Number(c.pnl_percent));else p=Number(((Math.random()*2-1)*Math.abs(Number(c.pnl_percent||5))).toFixed(2))}
 const pnl=Number((Number(amount)*p/100).toFixed(8));
 const {rows}=await pool.query("insert into trades(user_id,side,symbol,amount,simulated_pnl,pnl_percent,mode) values($1,$2,$3,$4,$5,$6,'SIMULATION') returning id,side,symbol,amount,simulated_pnl,pnl_percent,mode,created_at",[req.user.id,side,symbol,Number(amount),pnl,p]);
 res.status(201).json(rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:"database_error"})}
});

app.get("/api/admin/users",auth,admin,async(_req,res)=>{const {rows}=await pool.query("select u.id,u.display_name,u.email,u.role,coalesce(s.mode,'RANDOM') simulation_mode,coalesce(s.pnl_percent,0) simulation_pnl_percent,coalesce(s.enabled,true) simulation_enabled from users u left join simulation_controls s on s.user_id=u.id order by u.created_at desc");res.json(rows)});
app.put("/api/admin/simulation-controls/:userId",auth,admin,async(req,res)=>{
 const id=Number(req.params.userId),{mode,pnlPercent,enabled}=req.body||{};
 if(!Number.isInteger(id)||!["RANDOM","PROFIT","LOSS"].includes(mode)||!Number.isFinite(Number(pnlPercent))||Number(pnlPercent)<0||Number(pnlPercent)>100||typeof enabled!=="boolean")return res.status(400).json({error:"invalid_simulation_control"});
 const {rows}=await pool.query("insert into simulation_controls(user_id,mode,pnl_percent,enabled) values($1,$2,$3,$4) on conflict(user_id) do update set mode=excluded.mode,pnl_percent=excluded.pnl_percent,enabled=excluded.enabled,updated_at=now() returning user_id,mode,pnl_percent,enabled",[id,mode,Number(pnlPercent),enabled]);
 res.json({simulation_only:true,control:rows[0]});
});

const USDT_NETWORKS=["TRC20","ERC20","BEP20","POLYGON","SOLANA","ARBITRUM","OPTIMISM"];
const SUPPORTED_CRYPTO=["USDT","BTC","ETH","BNB","SOL"];
app.get("/api/wallet/summary",auth,async(req,res)=>{try{const a=await pool.query("select asset,balance,updated_at from wallets where user_id=$1 order by asset",[req.user.id]);const t=await pool.query("select id,type,asset,amount,status,network,created_at from wallet_transactions where user_id=$1 order by created_at desc limit 30",[req.user.id]);res.json({assets:a.rows,transactions:t.rows,simulation_only:true})}catch(e){console.error(e);res.status(500).json({error:"database_error"})}});
app.get("/api/crypto/options",auth,(_req,res)=>res.json({assets:SUPPORTED_CRYPTO,usdtNetworks:USDT_NETWORKS,simulation_only:true}));
app.post("/api/deposits",auth,async(req,res)=>{const {asset="USDT",network="TRC20",amount,txHash=""}=req.body||{};if(!SUPPORTED_CRYPTO.includes(asset)||!Number.isFinite(Number(amount))||Number(amount)<=0)return res.status(400).json({error:"invalid_deposit"});if(asset==="USDT"&&!USDT_NETWORKS.includes(network))return res.status(400).json({error:"unsupported_network"});try{const {rows}=await pool.query("insert into wallet_transactions(user_id,type,asset,amount,network,tx_hash,status,notes) values($1,'DEPOSIT',$2,$3,$4,$5,'PENDING','Awaiting admin review') returning *",[req.user.id,asset,Number(amount),network,String(txHash||"")]);res.status(201).json({simulation_only:true,transaction:rows[0]})}catch(e){console.error(e);res.status(500).json({error:"database_error"})}});
app.post("/api/withdrawals",auth,async(req,res)=>{const {asset="USDT",network="TRC20",amount,address}=req.body||{};if(!SUPPORTED_CRYPTO.includes(asset)||!Number.isFinite(Number(amount))||Number(amount)<=0||!String(address||"").trim())return res.status(400).json({error:"invalid_withdrawal"});if(asset==="USDT"&&!USDT_NETWORKS.includes(network))return res.status(400).json({error:"unsupported_network"});try{const b=await pool.query("select balance from wallets where user_id=$1 and asset=$2",[req.user.id,asset]);if(Number(amount)>Number(b.rows[0]?.balance||0))return res.status(400).json({error:"insufficient_balance"});const {rows}=await pool.query("insert into wallet_transactions(user_id,type,asset,amount,network,address,status,notes) values($1,'WITHDRAWAL',$2,$3,$4,$5,'PENDING','Awaiting admin review') returning *",[req.user.id,asset,Number(amount),network,String(address).trim()]);res.status(201).json({simulation_only:true,transaction:rows[0]})}catch(e){console.error(e);res.status(500).json({error:"database_error"})}});
app.post("/api/support/tickets",auth,async(req,res)=>{const {subject="General question",message}=req.body||{};if(!String(message||"").trim())return res.status(400).json({error:"message_required"});try{const {rows}=await pool.query("insert into support_tickets(user_id,subject,message,status) values($1,$2,$3,'OPEN') returning *",[req.user.id,String(subject).slice(0,120),String(message).slice(0,4000)]);res.status(201).json(rows[0])}catch(e){console.error(e);res.status(500).json({error:"database_error"})}});
app.get("/api/support/tickets",auth,async(req,res)=>{const {rows}=await pool.query("select * from support_tickets where user_id=$1 order by created_at desc",[req.user.id]);res.json(rows)});
app.get("/api/admin/dashboard",auth,admin,async(_req,res)=>{const [u,d,w,t,s]=await Promise.all([pool.query("select count(*)::int count from users where role='user'"),pool.query("select count(*)::int count from wallet_transactions where status='PENDING' and type='DEPOSIT'"),pool.query("select coalesce(sum(balance),0) total from wallets"),pool.query("select count(*)::int count from wallet_transactions where type='WITHDRAWAL' and status='PENDING'"),pool.query("select count(*)::int count from support_tickets where status in ('OPEN','IN_PROGRESS')")]);res.json({users:u.rows[0].count,pendingDeposits:d.rows[0].count,totalSimulationBalance:w.rows[0].total,pendingWithdrawals:t.rows[0].count,openTickets:s.rows[0].count})});
app.get("/api/admin/transactions",auth,admin,async(req,res)=>{const status=req.query.status;const q=status?await pool.query("select wt.*,u.display_name,u.email from wallet_transactions wt join users u on u.id=wt.user_id where wt.status=$1 order by wt.created_at desc limit 200",[status]):await pool.query("select wt.*,u.display_name,u.email from wallet_transactions wt join users u on u.id=wt.user_id order by wt.created_at desc limit 200");res.json(q.rows)});
app.patch("/api/admin/transactions/:id",auth,admin,async(req,res)=>{const id=Number(req.params.id),{status,reason=""}=req.body||{};if(!Number.isInteger(id)||!["ACCEPTED","REJECTED"].includes(status))return res.status(400).json({error:"invalid_status"});const client=await pool.connect();try{await client.query("begin");const x=await client.query("select * from wallet_transactions where id=$1 for update",[id]);if(!x.rowCount){await client.query("rollback");return res.status(404).json({error:"not_found"})}const tx=x.rows[0];if(tx.status!=="PENDING"){await client.query("rollback");return res.status(409).json({error:"already_reviewed"})}if(status==="ACCEPTED"&&tx.type==="DEPOSIT")await client.query("insert into wallets(user_id,asset,balance) values($1,$2,$3) on conflict(user_id,asset) do update set balance=wallets.balance+excluded.balance,updated_at=now()",[tx.user_id,tx.asset,tx.amount]);if(status==="ACCEPTED"&&tx.type==="WITHDRAWAL"){const b=await client.query("select balance from wallets where user_id=$1 and asset=$2 for update",[tx.user_id,tx.asset]);if(Number(b.rows[0]?.balance||0)<Number(tx.amount))throw new Error("insufficient_balance");await client.query("update wallets set balance=balance-$1,updated_at=now() where user_id=$2 and asset=$3",[tx.amount,tx.user_id,tx.asset])}const {rows}=await client.query("update wallet_transactions set status=$1,review_reason=$2,reviewed_by=$3,reviewed_at=now() where id=$4 returning *",[status,String(reason).slice(0,500),req.user.id,id]);await client.query("commit");res.json({simulation_only:true,transaction:rows[0]})}catch(e){await client.query("rollback").catch(()=>{});console.error(e);res.status(400).json({error:e.message==="insufficient_balance"?"insufficient_balance":"review_failed"})}finally{client.release()}});
app.post("/api/admin/users/:userId/balance",auth,admin,async(req,res)=>{const uid=Number(req.params.userId),{asset="USDT",amount,operation="ADD",reason=""}=req.body||{};if(!Number.isInteger(uid)||!SUPPORTED_CRYPTO.includes(asset)||!Number.isFinite(Number(amount))||Number(amount)<=0||!["ADD","SUBTRACT"].includes(operation))return res.status(400).json({error:"invalid_balance_adjustment"});const delta=operation==="ADD"?Number(amount):-Number(amount);try{const {rows}=await pool.query("insert into wallets(user_id,asset,balance) values($1,$2,$3) on conflict(user_id,asset) do update set balance=wallets.balance+$3,updated_at=now() returning *",[uid,asset,delta]);await pool.query("insert into wallet_transactions(user_id,type,asset,amount,status,notes,reviewed_by,reviewed_at) values($1,'ADMIN_ADJUSTMENT',$2,$3,'ACCEPTED',$4,$5,now())",[uid,asset,delta,String(reason||"Admin balance adjustment"),req.user.id]);res.json({simulation_only:true,wallet:rows[0]})}catch(e){console.error(e);res.status(400).json({error:"balance_adjustment_failed"})}});
app.get("/api/admin/tickets",auth,admin,async(_req,res)=>{const {rows}=await pool.query("select st.*,u.display_name,u.email from support_tickets st join users u on u.id=st.user_id order by st.created_at desc limit 200");res.json(rows)});
app.patch("/api/admin/tickets/:id",auth,admin,async(req,res)=>{const id=Number(req.params.id),{status,response=""}=req.body||{};if(!["OPEN","IN_PROGRESS","RESOLVED"].includes(status))return res.status(400).json({error:"invalid_status"});const {rows}=await pool.query("update support_tickets set status=$1,admin_response=$2,updated_at=now(),assigned_to=$3 where id=$4 returning *",[status,String(response).slice(0,4000),req.user.id,id]);res.json(rows[0]||null)});
app.get("/api/superadmin/security",auth,superadmin,async(_req,res)=>{const {rows}=await pool.query("select id,display_name,email,role,created_at from users order by created_at desc");res.json(rows)});
app.patch("/api/superadmin/users/:id/role",auth,superadmin,async(req,res)=>{const id=Number(req.params.id),{role}=req.body||{};if(!["user","admin","superadmin"].includes(role))return res.status(400).json({error:"invalid_role"});const {rows}=await pool.query("update users set role=$1 where id=$2 returning id,display_name,email,role",[role,id]);res.json(rows[0]||null)});

async function init(){
 if(!process.env.DATABASE_URL){console.warn("DATABASE_URL is not configured");return}
 await pool.query("alter table users add column if not exists password_hash text");
 await pool.query("alter table users add column if not exists role text not null default 'user'");
 await pool.query("alter table users add column if not exists first_name text");
 await pool.query("alter table users add column if not exists last_name text");
 await pool.query("alter table users add column if not exists phone text");
 await pool.query("alter table users add column if not exists country text");
 await pool.query("alter table users add column if not exists date_of_birth text");
 await pool.query("alter table wallets add column if not exists asset text");
 await pool.query("update wallets set asset='USDT' where asset is null");
 await pool.query("create unique index if not exists wallets_user_asset_uq on wallets(user_id,asset)");
 await pool.query("create table if not exists wallet_transactions(id bigserial primary key,user_id bigint references users(id) on delete cascade,type text not null,asset text not null,amount numeric(30,10) not null,network text,address text,tx_hash text,status text not null default 'PENDING',notes text,review_reason text,reviewed_by bigint references users(id),reviewed_at timestamptz,created_at timestamptz not null default now())");
 await pool.query("create table if not exists support_tickets(id bigserial primary key,user_id bigint references users(id) on delete cascade,subject text not null,message text not null,status text not null default 'OPEN',admin_response text,assigned_to bigint references users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now())");
 await pool.query("alter table trades add column if not exists user_id bigint references users(id) on delete cascade");
 await pool.query("alter table trades add column if not exists simulated_pnl numeric(30,10) not null default 0");
 await pool.query("alter table trades add column if not exists pnl_percent numeric(12,6) not null default 0");
 await pool.query("create table if not exists simulation_controls(user_id bigint primary key references users(id) on delete cascade,mode text not null default 'RANDOM',pnl_percent numeric(12,6) not null default 5,enabled boolean not null default true,updated_at timestamptz not null default now())");
 await pool.query("create table if not exists market_orders(id bigserial primary key,user_id bigint references users(id) on delete cascade,symbol text not null,side text not null,order_type text not null,price numeric(30,10),quantity numeric(30,10) not null,remaining_qty numeric(30,10) not null,status text not null default 'OPEN',created_at timestamptz not null default now(),updated_at timestamptz not null default now())");
 await pool.query("create index if not exists market_orders_book_idx on market_orders(symbol,side,status,price,created_at)");
 await pool.query("create table if not exists market_fills(id bigserial primary key,buy_order_id bigint references market_orders(id),sell_order_id bigint references market_orders(id),symbol text not null,price numeric(30,10) not null,quantity numeric(30,10) not null,maker_order_id bigint references market_orders(id),taker_order_id bigint references market_orders(id),created_at timestamptz not null default now())");
 await pool.query("create table if not exists market_ledger_events(id bigserial primary key,event_id uuid unique not null,event_type text not null,reference_id bigint,symbol text,quantity numeric(30,10),price numeric(30,10),metadata jsonb,user_id bigint references users(id) on delete cascade,created_at timestamptz not null default now())");
 await pool.query("insert into users(id,display_name,email,role) values(1,'Demo User','demo@stride.local','user') on conflict(id) do nothing");
 await pool.query("insert into wallets(user_id,balance,asset) values(1,0,'USDT') on conflict(user_id,asset) do nothing");
 await pool.query("insert into simulation_controls(user_id,mode,pnl_percent,enabled) values(1,'RANDOM',5,true) on conflict(user_id) do nothing");
 await pool.query("select setval(pg_get_serial_sequence('users','id'), coalesce((select max(id) from users),1), true)");
 if(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){const h=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);await pool.query("insert into users(display_name,email,password_hash,role) values('Stride Admin',$1,$2,'admin') on conflict(email) do update set password_hash=excluded.password_hash,role='admin'",[process.env.ADMIN_EMAIL.trim().toLowerCase(),h])}
 if(process.env.SECADMIN_EMAIL&&process.env.SECADMIN_PASSWORD){const h=await bcrypt.hash(process.env.SECADMIN_PASSWORD,12);await pool.query("insert into users(display_name,email,password_hash,role) values('Stride Security Admin',$1,$2,'superadmin') on conflict(email) do update set password_hash=excluded.password_hash,role='superadmin'",[process.env.SECADMIN_EMAIL.trim().toLowerCase(),h])}
}
mountMarketEngine(app,pool,auth);
const port=process.env.PORT||10000;
init().then(()=>app.listen(port,()=>console.log("Stride Markets API listening on "+port))).catch(e=>{console.error(e);process.exit(1)});