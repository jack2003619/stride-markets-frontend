import express from "express";
import cors from "cors";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
const {Pool}=pg, app=express();
app.use(cors()); app.use(express.json());
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
const JWT_SECRET=process.env.JWT_SECRET;
const token=(u)=>jwt.sign({sub:String(u.id),role:u.role,email:u.email},JWT_SECRET,{expiresIn:"7d"});
function auth(req,res,next){if(!JWT_SECRET)return res.status(503).json({error:"auth_not_configured"});try{const t=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");const p=jwt.verify(t,JWT_SECRET);req.user={id:Number(p.sub),role:p.role,email:p.email};next()}catch{res.status(401).json({error:"unauthorized"})}}
function admin(req,res,next){if(req.user?.role!=="admin")return res.status(403).json({error:"admin_only"});next()}

app.get("/health",async(_req,res)=>{try{await pool.query("select 1");res.json({ok:true,mode:"simulation",database:"connected"})}catch{res.status(503).json({ok:false,mode:"simulation",database:"unavailable"})}});

app.post("/api/auth/register",async(req,res)=>{
 const {displayName,email,password}=req.body||{};
 if(!displayName?.trim()||!email?.trim()||!password||password.length<8)return res.status(400).json({error:"display_name_email_and_8_char_password_required"});
 try{const e=email.trim().toLowerCase();if((await pool.query("select 1 from users where email=$1",[e])).rowCount)return res.status(409).json({error:"email_already_registered"});
 const h=await bcrypt.hash(password,12);
 const {rows}=await pool.query("insert into users(display_name,email,password_hash,role) values($1,$2,$3,'user') returning id,display_name,email,role",[displayName.trim(),e,h]);
 await pool.query("insert into wallets(user_id,balance,asset) values($1,0,'USDT') on conflict(user_id,asset) do nothing",[rows[0].id]);
 await pool.query("insert into simulation_controls(user_id,mode,pnl_percent,enabled) values($1,'RANDOM',5,true) on conflict(user_id) do nothing",[rows[0].id]);
 res.status(201).json({user:rows[0],token:token(rows[0])});
 }catch(e){console.error(e);res.status(500).json({error:"database_error"})}
});

app.post("/api/auth/login",async(req,res)=>{
 const {email,password}=req.body||{};if(!email?.trim()||!password)return res.status(400).json({error:"email_and_password_required"});
 try{const {rows}=await pool.query("select id,display_name,email,role,password_hash from users where email=$1",[email.trim().toLowerCase()]);const u=rows[0];
 if(!u||!(await bcrypt.compare(password,u.password_hash||"")))return res.status(401).json({error:"invalid_credentials"});
 const safe={id:u.id,display_name:u.display_name,email:u.email,role:u.role};res.json({user:safe,token:token(safe)});
 }catch{res.status(500).json({error:"database_error"})}
});
app.get("/api/auth/me",auth,async(req,res)=>{const {rows}=await pool.query("select id,display_name,email,role,created_at from users where id=$1",[req.user.id]);res.json(rows[0]||null)});

app.get("/api/profile",auth,async(req,res)=>{const {rows}=await pool.query("select id,display_name,email,role from users where id=$1",[req.user.id]);res.json(rows[0]||null)});
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

async function init(){
 if(!process.env.DATABASE_URL){console.warn("DATABASE_URL is not configured");return}
 await pool.query("alter table users add column if not exists password_hash text");
 await pool.query("alter table users add column if not exists role text not null default 'user'");
 await pool.query("alter table trades add column if not exists user_id bigint references users(id) on delete cascade");
 await pool.query("alter table trades add column if not exists simulated_pnl numeric(30,10) not null default 0");
 await pool.query("alter table trades add column if not exists pnl_percent numeric(12,6) not null default 0");
 await pool.query("create table if not exists simulation_controls(user_id bigint primary key references users(id) on delete cascade,mode text not null default 'RANDOM',pnl_percent numeric(12,6) not null default 5,enabled boolean not null default true,updated_at timestamptz not null default now())");
 await pool.query("insert into users(id,display_name,email,role) values(1,'Demo User','demo@stride.local','user') on conflict(id) do nothing");
 await pool.query("insert into wallets(user_id,balance,asset) values(1,0,'USDT') on conflict(user_id,asset) do nothing");
 await pool.query("insert into simulation_controls(user_id,mode,pnl_percent,enabled) values(1,'RANDOM',5,true) on conflict(user_id) do nothing");
}
const port=process.env.PORT||10000;
init().then(()=>app.listen(port,()=>console.log("Stride Markets API listening on "+port))).catch(e=>{console.error(e);process.exit(1)});