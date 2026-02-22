import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import { randomUUID } from 'crypto';

dotenv.config();

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_BOT_TOKEN:     process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:       process.env.TELEGRAM_CHAT_ID,

  SPREAD_ENTRY_THRESHOLD: parseFloat(process.env.SPREAD_ENTRY_THRESHOLD || '0.5'),
  SPREAD_EXIT_THRESHOLD:  parseFloat(process.env.SPREAD_EXIT_THRESHOLD  || '0.2'),
  SIGNAL_COOLDOWN_MS:     parseInt(process.env.SIGNAL_COOLDOWN_MS       || '60000'),

  KC_FUTURES_REST:    'https://api-futures.kucoin.com',
  SYMBOLS_PER_CONN:   parseInt(process.env.SYMBOLS_PER_CONN || '50'), // перевірено: 50 працює
  RECONNECT_DELAY_MS: 5_000,
};

if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('[ERROR] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// ─── STATE ─────────────────────────────────────────────────────────────────────
const tg = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);

const state = {
  symbols:        [],
  activeSignals:  new Map(),
  lastSignalTime: new Map(),
  markPrice:      new Map(), // symbol → markPrice  (з /contract/instrument)
  bidPrice:       new Map(), // symbol → bestBidPrice (з tickerV2)
  askPrice:       new Map(), // symbol → bestAskPrice (з tickerV2)
  connections:    [],
  stats: { instrument: 0, ticker: 0, lastLog: Date.now() },
};

// ─── TELEGRAM ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' })
    .catch(err => console.error('[TG] Error:', err.message));
}

// ─── ФОРМАТУВАННЯ ──────────────────────────────────────────────────────────────
function formatEntry(symbol, spread, execPrice, markPrice, direction) {
  const icon = direction === 'LONG' ? '🟢' : '🔴';
  const priceLabel = direction === 'LONG' ? 'ASK (купити по)' : 'BID (продати по)';
  const time = new Date().toISOString().slice(11, 23) + ' UTC';
  return (
    `🚨 <b>KuCoin - ${Math.abs(spread).toFixed(2)}%</b>\n\n` +
    `👉<b>${symbol}</b>👈\n\n` +
    `${icon} <b>${direction}</b>\n` +
    `💱 ${priceLabel}: ${execPrice}\n` +
    `⚖️ Справедлива: ${markPrice}\n` +
    `⏰ Виявлено: ${time}`
  );
}

function formatExit(symbol, execPrice, markPrice, spread, sig) {
  const elapsed = Date.now() - sig.entryTime;
  const secs = Math.floor(elapsed / 1000);
  const ms   = elapsed % 1000;
  return (
    `✅ <b>${symbol} - Ціни зрівнялись!</b>\n\n` +
    `⏱️ Через: ${secs} сек ${ms} мс\n` +
    `💰 Ціна: ${execPrice}\n` +
    `⚖️ Справедлива: ${markPrice}\n` +
    `📊 Відхилення: ${Math.abs(spread).toFixed(2)}%\n` +
    `📉 Було відхилення: ${Math.abs(sig.entrySpread).toFixed(2)}%`
  );
}

// ─── ЛОГІКА СПРЕДУ ─────────────────────────────────────────────────────────────
function checkSpread(symbol) {
  const markPrice = state.markPrice.get(symbol);
  const bid       = state.bidPrice.get(symbol);
  const ask       = state.askPrice.get(symbol);

  if (!markPrice || markPrice === 0) return;
  if (!bid && !ask) return;

  // LONG: виконуємо по ASK — купуємо за найкращою ціною продавця
  // Сигнал тільки якщо ask < markPrice (ринок дешевший за справедливу ціну)
  const askSpread = ask ? ((ask - markPrice) / markPrice) * 100 : null;
  const longSignal = askSpread !== null && askSpread < 0 ? askSpread : null;

  // SHORT: виконуємо по BID — продаємо за найкращою ціною покупця
  // Сигнал тільки якщо bid > markPrice (ринок дорожчий за справедливу ціну)
  const bidSpread = bid ? ((bid - markPrice) / markPrice) * 100 : null;
  const shortSignal = bidSpread !== null && bidSpread > 0 ? bidSpread : null;

  // Немає жодного сигналу — bid/ask всередині markPrice, все нормально
  if (longSignal === null && shortSignal === null) return;

  // Беремо сильніший сигнал
  let spread, execPrice, direction;
  if (longSignal !== null && (shortSignal === null || Math.abs(longSignal) >= Math.abs(shortSignal))) {
    spread = longSignal; execPrice = ask; direction = 'LONG';
  } else {
    spread = shortSignal; execPrice = bid; direction = 'SHORT';
  }

  const absSpread = Math.abs(spread);
  const hasSignal = state.activeSignals.has(symbol);
  const cooldown  = (Date.now() - (state.lastSignalTime.get(symbol) || 0)) >= CONFIG.SIGNAL_COOLDOWN_MS;

  // ── ENTRY ──────────────────────────────────────────────────────────────────
  if (!hasSignal && absSpread >= CONFIG.SPREAD_ENTRY_THRESHOLD && cooldown) {
    console.log(`[ENTRY] ${symbol} ${direction} spread=${spread.toFixed(3)}% exec=${execPrice} mark=${markPrice}`);
    state.activeSignals.set(symbol, { direction, entryTime: Date.now(), entrySpread: spread });
    state.lastSignalTime.set(symbol, Date.now());
    sendTelegram(formatEntry(symbol, spread, execPrice, markPrice, direction));
    return;
  }

  // ── EXIT ───────────────────────────────────────────────────────────────────
  if (hasSignal && absSpread <= CONFIG.SPREAD_EXIT_THRESHOLD) {
    const sig = state.activeSignals.get(symbol);
    console.log(`[EXIT]  ${symbol} spread=${spread.toFixed(3)}%`);
    state.activeSignals.delete(symbol);
    sendTelegram(formatExit(symbol, execPrice, markPrice, spread, sig));
  }
}

// ─── СТАТИСТИКА ────────────────────────────────────────────────────────────────
function logStats() {
  if (Date.now() - state.stats.lastLog < 2 * 60 * 1000) return;
  console.log(`[STATS] instrument/2min=${state.stats.instrument} | ticker/2min=${state.stats.ticker} | activeSignals=${state.activeSignals.size}`);
  for (const [sym, sig] of state.activeSignals) {
    const age = Math.round((Date.now() - sig.entryTime) / 1000);
    console.log(`  → ${sym} ${sig.direction} entry=${sig.entrySpread.toFixed(3)}% | ${age}s ago`);
  }
  state.stats.instrument = 0;
  state.stats.ticker     = 0;
  state.stats.lastLog    = Date.now();
}

// ─── ПАРСИНГ ───────────────────────────────────────────────────────────────────
function handleMessage(msg) {
  if (msg.type !== 'message') return;

  const topic   = msg.topic   ?? '';
  const subject = msg.subject ?? '';
  const data    = msg.data    ?? {};

  logStats();

  // /contract/instrument → subject: 'mark.index.price'
  if (subject === 'mark.index.price') {
    state.stats.instrument++;
    const symbol = topic.split(':')[1]?.split(',')[0]?.trim();
    if (!symbol) return;
    const mp = parseFloat(data.markPrice);
    if (!isNaN(mp) && mp > 0) {
      state.markPrice.set(symbol, mp);
      if (state.bidPrice.has(symbol) || state.askPrice.has(symbol)) checkSpread(symbol);
    }
    return;
  }

  // /contractMarket/tickerV2 → subject: 'tickerV2'
  if (subject === 'tickerV2' || topic.startsWith('/contractMarket/tickerV2')) {
    state.stats.ticker++;
    // При comma-list підписці symbol береться з data.symbol
    const symbol = data.symbol ?? topic.split(':')[1]?.split(',')[0]?.trim();
    if (!symbol) return;
    const bid = parseFloat(data.bestBidPrice ?? NaN);
    const ask = parseFloat(data.bestAskPrice ?? NaN);
    if (!isNaN(bid) && bid > 0) state.bidPrice.set(symbol, bid);
    if (!isNaN(ask) && ask > 0) state.askPrice.set(symbol, ask);
    if (state.markPrice.has(symbol)) checkSpread(symbol);
    return;
  }
}

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────────
async function getPublicToken() {
  const res = await axios.post(`${CONFIG.KC_FUTURES_REST}/api/v1/bullet-public`);
  if (res.data.code !== '200000') throw new Error(`Token error: ${res.data.msg}`);
  const { token, instanceServers } = res.data.data;
  const srv = instanceServers[0];
  return { token, endpoint: srv.endpoint, pingIntervalMs: srv.pingInterval };
}

function createConnection(symbols, tokenInfo, connIndex) {
  return new Promise((resolve, reject) => {
    const url = `${tokenInfo.endpoint}?token=${tokenInfo.token}&connectId=${randomUUID().replace(/-/g,'')}`;
    console.log(`[WS #${connIndex + 1}] Connecting (${symbols.length} symbols)...`);

    const ws = new WebSocket(url);
    let resolved = false;
    let pingTimer = null;

    ws.on('open', () => console.log(`[WS #${connIndex + 1}] Connected`));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'welcome') {
          pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ id: Date.now().toString(), type: 'ping' }));
            }
          }, tokenInfo.pingIntervalMs - 2000);

          const symList = symbols.join(',');

          // Обидві підписки через comma-list — перевірено що працює
          ws.send(JSON.stringify({
            id: `inst_${connIndex}`, type: 'subscribe',
            topic: `/contract/instrument:${symList}`, response: true,
          }));
          ws.send(JSON.stringify({
            id: `tick_${connIndex}`, type: 'subscribe',
            topic: `/contractMarket/tickerV2:${symList}`, response: true,
          }));

          console.log(`[WS #${connIndex + 1}] Subscribed instrument + tickerV2 (${symbols.length} symbols)`);
          if (!resolved) { resolved = true; resolve(ws); }
          return;
        }

        if (msg.type === 'pong') return;
        if (msg.type === 'ack') {
          console.log(`[WS #${connIndex + 1}] ACK: ${msg.id}`);
          return;
        }

        handleMessage(msg);
      } catch (err) {
        console.error(`[WS #${connIndex + 1}] Parse error:`, err.message);
      }
    });

    ws.on('error', err => console.error(`[WS #${connIndex + 1}] Error:`, err.message));

    ws.on('close', () => {
      clearInterval(pingTimer);
      console.log(`[WS #${connIndex + 1}] Closed. Reconnecting in ${CONFIG.RECONNECT_DELAY_MS}ms...`);
      setTimeout(async () => {
        try {
          const tok = await getPublicToken();
          state.connections[connIndex] = await createConnection(symbols, tok, connIndex);
        } catch (err) {
          console.error(`[RECONNECT #${connIndex + 1}] Failed:`, err.message);
        }
      }, CONFIG.RECONNECT_DELAY_MS);
    });

    setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error(`Timeout #${connIndex + 1}`)); }
    }, 30_000);
  });
}

// ─── ІНІЦІАЛІЗАЦІЯ ─────────────────────────────────────────────────────────────
async function fetchSymbols() {
  console.log('[API] Fetching active USDT futures symbols...');
  const res = await axios.get(`${CONFIG.KC_FUTURES_REST}/api/v1/contracts/active`);
  if (res.data.code !== '200000') throw new Error(res.data.msg);
  const symbols = res.data.data
    .filter(c => c.status === 'Open' && c.settleCurrency === 'USDT')
    .map(c => c.symbol);
  console.log(`[API] Found ${symbols.length} active USDT symbols`);
  return symbols;
}

async function initConnections() {
  const chunks = [];
  for (let i = 0; i < state.symbols.length; i += CONFIG.SYMBOLS_PER_CONN) {
    chunks.push(state.symbols.slice(i, i + CONFIG.SYMBOLS_PER_CONN));
  }
  console.log(`[WS] Creating ${chunks.length} connection(s) (${CONFIG.SYMBOLS_PER_CONN} symbols each)...`);
  for (let i = 0; i < chunks.length; i++) {
    const tok = await getPublicToken();
    const ws  = await createConnection(chunks[i], tok, i);
    state.connections.push(ws);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[WS] All ${chunks.length} connection(s) established`);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('📊 KUCOIN FUTURES SPREAD MONITOR');
  console.log('='.repeat(60));
  console.log(`[CONFIG] Entry    : ${CONFIG.SPREAD_ENTRY_THRESHOLD}%`);
  console.log(`[CONFIG] Exit     : ${CONFIG.SPREAD_EXIT_THRESHOLD}%`);
  console.log(`[CONFIG] Cooldown : ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`);
  console.log('='.repeat(60));

  state.symbols = await fetchSymbols();
  await initConnections();

  console.log('[BOT] ✅ Monitoring spreads...');
  sendTelegram(
    `🤖 <b>KUCOIN SPREAD MONITOR STARTED</b>\n\n` +
    `Моніторинг: ${state.symbols.length} USDT ф'ючерсів\n` +
    `Поріг входу: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%\n` +
    `Поріг виходу: ${CONFIG.SPREAD_EXIT_THRESHOLD}%`
  );
}

process.on('SIGINT', () => {
  state.connections.forEach(ws => { if (ws?.readyState === WebSocket.OPEN) ws.close(); });
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '🛑 <b>KUCOIN SPREAD MONITOR STOPPED</b>', { parse_mode: 'HTML' })
    .finally(() => process.exit(0));
});
process.on('SIGTERM', () => process.exit(0));

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
