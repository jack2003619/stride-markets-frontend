import { randomUUID } from "node:crypto";

export function mountMarketEngine(app, pool, auth) {
  const PRICE_CACHE = new Map();
  const PRICE_TTL_MS = 15000;
  const CG_IDS = { BTC:"bitcoin", ETH:"ethereum", BNB:"binancecoin", SOL:"solana", USDT:"tether" };

  app.get("/api/market/prices", async (req,res)=>{
    const symbols=String(req.query.symbols||"BTC,ETH,BNB,SOL,USDT").split(",").map(x=>x.trim().toUpperCase()).filter(x=>CG_IDS[x]);
    const ids=symbols.map(x=>CG_IDS[x]);
    try{
      const now=Date.now();
      const fresh=ids.every(id=>{const x=PRICE_CACHE.get(id);return x&&now-x.at<PRICE_TTL_MS});
      if(!fresh){
        const r=await fetch("https://api.coingecko.com/api/v3/simple/price?ids="+encodeURIComponent(ids.join(","))+"&vs_currencies=usd&include_24hr_change=true");
        if(!r.ok) throw new Error("price_provider_unavailable");
        const d=await r.json(); for(const id of ids) PRICE_CACHE.set(id,{at:now,data:d[id]||{}});
      }
      res.json({source:"CoinGecko",prices:Object.fromEntries(symbols.map(s=>[s,PRICE_CACHE.get(CG_IDS[s])?.data||{}])),updated_at:new Date().toISOString()});
    }catch(e){res.status(503).json({error:"price_provider_unavailable"})}
  });


  // Public exchange market-data proxy. This is live market data only; execution remains
  // behind the authenticated simulation/order engine until a compliant execution provider is configured.
  app.get("/api/market/exchange-symbols", async (req,res)=>{
    try{
      const r=await fetch("https://api.binance.com/api/v3/exchangeInfo");
      if(!r.ok) throw new Error("exchange_info_unavailable");
      const d=await r.json();
      const symbols=(d.symbols||[]).filter(x=>x.status==="TRADING"&&x.quoteAsset==="USDT").map(x=>({symbol:x.symbol,base:x.baseAsset,quote:x.quoteAsset}));
      res.json({source:"Binance public market data",symbols,updated_at:new Date().toISOString()});
    }catch(e){res.status(503).json({error:"exchange_info_unavailable"})}
  });

  app.get("/api/market/live-tickers", async (req,res)=>{
    try{
      const r=await fetch("https://api.binance.com/api/v3/ticker/24hr");
      if(!r.ok) throw new Error("ticker_unavailable");
      const d=await r.json();
      const rows=(Array.isArray(d)?d:[]).filter(x=>/USDT$/.test(x.symbol)&&Number(x.lastPrice)>0).map(x=>({symbol:x.symbol,price:Number(x.lastPrice),change_pct:Number(x.priceChangePercent||0),volume:Number(x.volume||0),high:Number(x.highPrice||0),low:Number(x.lowPrice||0),quoteVolume:Number(x.quoteVolume||0)}));
      res.json({source:"Binance public market data",rows,updated_at:new Date().toISOString()});
    }catch(e){res.status(503).json({error:"ticker_unavailable"})}
  });

  app.get("/api/market/live-orderbook/:symbol", async (req,res)=>{
    const symbol=String(req.params.symbol||"").toUpperCase();
    if(!/^[A-Z0-9]{5,20}$/.test(symbol)) return res.status(400).json({error:"invalid_symbol"});
    try{
      const r=await fetch("https://api.binance.com/api/v3/depth?symbol="+encodeURIComponent(symbol)+"&limit=20");
      if(!r.ok) throw new Error("orderbook_unavailable");
      const d=await r.json();
      res.json({source:"Binance public market data",symbol,bids:d.bids||[],asks:d.asks||[],lastUpdateId:d.lastUpdateId,updated_at:new Date().toISOString()});
    }catch(e){res.status(503).json({error:"orderbook_unavailable"})}
  });

  app.get("/api/market/orderbook/:symbol", async(req,res)=>{
    const symbol=String(req.params.symbol||"").toUpperCase();
    if(!/^[A-Z0-9_-]{2,20}$/.test(symbol)) return res.status(400).json({error:"invalid_symbol"});
    try{
      const [bids,asks]=await Promise.all([
        pool.query("select price,coalesce(sum(remaining_qty),0) quantity from market_orders where symbol=$1 and side='BUY' and status='OPEN' group by price order by price desc limit 25",[symbol]),
        pool.query("select price,coalesce(sum(remaining_qty),0) quantity from market_orders where symbol=$1 and side='SELL' and status='OPEN' group by price order by price asc limit 25",[symbol])
      ]);
      res.json({symbol,bids:bids.rows,asks:asks.rows,updated_at:new Date().toISOString()});
    }catch(e){res.status(500).json({error:"orderbook_unavailable"})}
  });

  app.get("/api/market/orders",auth,async(req,res)=>{
    try{const {rows}=await pool.query("select id,symbol,side,order_type,price,quantity,remaining_qty,status,created_at from market_orders where user_id=$1 order by created_at desc limit 100",[req.user.id]);res.json(rows)}
    catch(e){res.status(500).json({error:"orders_unavailable"})}
  });

  app.post("/api/market/orders",auth,async(req,res)=>{
    const {symbol,side,orderType="LIMIT",price,quantity}=req.body||{};
    const s=String(symbol||"").toUpperCase(), sd=String(side||"").toUpperCase(), ot=String(orderType||"").toUpperCase();
    const q=Number(quantity), p=Number(price);
    if(!/^[A-Z0-9_-]{2,20}$/.test(s)||!["BUY","SELL"].includes(sd)||!["LIMIT","MARKET"].includes(ot)||!Number.isFinite(q)||q<=0||(ot==="LIMIT"&&(!Number.isFinite(p)||p<=0))) return res.status(400).json({error:"invalid_order"});
    const client=await pool.connect();
    try{
      await client.query("begin");
      const ins=await client.query("insert into market_orders(user_id,symbol,side,order_type,price,quantity,remaining_qty,status) values($1,$2,$3,$4,$5,$6,$6,'OPEN') returning *",[req.user.id,s,sd,ot,ot==="MARKET"?null:p,q]);
      let order=ins.rows[0];
      const opposite=sd==="BUY"?"SELL":"BUY";
      const sort=sd==="BUY"?"asc":"desc";
      const matches=await client.query("select * from market_orders where symbol=$1 and side=$2 and status='OPEN' and user_id<>$3 and ($4='MARKET' or price is not null and (($5='BUY' and price <= $6) or ($5='SELL' and price >= $6))) order by price "+sort+",created_at asc for update",[s,opposite,req.user.id,ot,sd,p||0]);
      for(const m of matches.rows){
        if(Number(order.remaining_qty)<=0) break;
        const fillQty=Math.min(Number(order.remaining_qty),Number(m.remaining_qty));
        const fillPrice=Number(m.price);
        if(!Number.isFinite(fillPrice)||fillPrice<=0) continue;
        const fill=await client.query("insert into market_fills(buy_order_id,sell_order_id,symbol,price,quantity,maker_order_id,taker_order_id) values($1,$2,$3,$4,$5,$6,$7) returning *",[sd==="BUY"?order.id:m.id,sd==="SELL"?order.id:m.id,s,fillPrice,fillQty,m.id,order.id]);
        await client.query("update market_orders set remaining_qty=remaining_qty-$1,status=case when remaining_qty-$1<=0 then 'FILLED' else 'OPEN' end,updated_at=now() where id=$2",[fillQty,m.id]);
        await client.query("update market_orders set remaining_qty=remaining_qty-$1,status=case when remaining_qty-$1<=0 then 'FILLED' else 'OPEN' end,updated_at=now() where id=$2",[fillQty,order.id]);
        await client.query("insert into market_ledger_events(event_id,user_id,event_type,reference_id,symbol,quantity,price,metadata) values($1,$2,'FILL',$3,$4,$5,$6,$7)",[randomUUID(),req.user.id,fill.rows[0].id,s,fillQty,fillPrice,JSON.stringify({counterparty_order:m.id})]);
        order.remaining_qty=Number(order.remaining_qty)-fillQty;
      }
      const fresh=await client.query("select * from market_orders where id=$1",[order.id]);
      await client.query("commit");
      res.status(201).json({order:fresh.rows[0],simulation_only:true});
    }catch(e){await client.query("rollback").catch(()=>{});console.error(e);res.status(400).json({error:"order_rejected"})}finally{client.release()}
  });

  app.get("/api/market/fills",auth,async(req,res)=>{
    try{const {rows}=await pool.query("select f.id,f.symbol,f.price,f.quantity,f.created_at from market_fills f join market_orders o on o.id in (f.buy_order_id,f.sell_order_id) where o.user_id=$1 order by f.created_at desc limit 100",[req.user.id]);res.json(rows)}
    catch(e){res.status(500).json({error:"fills_unavailable"})}
  });

  app.get("/api/onchain/tx/:hash",auth,async(req,res)=>{
    const hash=String(req.params.hash||"");
    const rpc=process.env.TESTNET_RPC_URL;
    if(!rpc) return res.status(503).json({error:"testnet_rpc_not_configured"});
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash)) return res.status(400).json({error:"invalid_tx_hash"});
    try{
      const call=async(method,params)=>{const r=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});const d=await r.json();if(d.error)throw new Error(d.error.message||"rpc_error");return d.result};
      const [tx,receipt,block]=await Promise.all([call("eth_getTransactionByHash",[hash]),call("eth_getTransactionReceipt",[hash]),call("eth_blockNumber",[])]);
      const confirmations=receipt&&block?Math.max(0,parseInt(block,16)-parseInt(receipt.blockNumber,16)+1):0;
      res.json({network:process.env.TESTNET_NAME||"configured EVM test network",hash,found:!!tx,receipt,confirmations});
    }catch(e){res.status(503).json({error:"rpc_unavailable"})}
  });

  app.get("/api/ledger/audit",auth,async(req,res)=>{
    try{
      const {rows}=await pool.query("select event_id,event_type,reference_id,symbol,quantity,price,metadata,created_at from market_ledger_events where user_id=$1 order by created_at desc limit 200",[req.user.id]);
      res.json(rows);
    }catch(e){res.status(500).json({error:"audit_unavailable"})}
  });
}
