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

  KC_FUTURES_REST:  'https://api-futures.kucoin.com',
  SYMBOLS_PER_SUB:  parseInt(process.env.SYMBOLS_PER_SUB || '50'),
  RECONNECT_DELAY_MS: 5_000,

  // ── DEBUG ──────────────────────────────────────────────────────────────────
  // true = виводить перші N сирих повідомлень у консоль, щоб побачити реальну
  // структуру даних KuCoin (topic, subject, data fields)
  DEBUG_RAW_MESSAGES: process.env.DEBUG_RAW_MESSAGES === 'true',
  DEBUG_LIMIT:        parseInt(process.env.DEBUG_LIMIT || '5'),
};

if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('[ERROR] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// ─── STATE ─────────────────────────────────────────────────────────────────────
const tg = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);

const state = {
  symbols:          [],
  activeSignals:    new Map(),
  lastSignalTime:   new Map(),
  lastIndexPrice:   new Map(),
  connections:      [],
  debugMsgCount:    0,      // лічильник для debug-режиму
  totalMsgCount:    0,      // загальна кількість отриманих data-повідомлень
  lastStatsLog:     Date.now(),
};

// ─── TELEGRAM ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' })
    .catch(err => console.error('[TG] Error:', err.message));
}

// ─── ФОРМАТУВАННЯ ──────────────────────────────────────────────────────────────
function formatEntry(symbol, spread, markPrice, indexPrice) {
  const direction = markPrice < indexPrice ? '🟢' : '🔴';
  const millisStr = new Date().toISOString().slice(11, 23) + ' UTC';
  return (
    `🚨 <b>KuCoin - ${Math.abs(spread).toFixed(2)}%</b>\n\n` +
    `👉<b>${symbol}</b>👈\n\n` +
    `${direction} Остання ціна: ${markPrice}\n` +
    `⚖️ Справедлива: ${indexPrice}\n` +
    `⏰ Виявлено: ${millisStr}`
  );
}

function formatExit(symbol, markPrice, indexPrice, spread, sig) {
  const elapsed = Date.now() - sig.entryTime;
  const secs = Math.floor(elapsed / 1000);
  const ms   = elapsed % 1000;
  return (
    `✅ <b>${symbol} - Ціни зрівнялись!</b>\n\n` +
    `⏱️ Через: ${secs} сек ${ms} мс\n` +
    `💰 Остання ціна: ${markPrice}\n` +
    `⚖️ Справедлива: ${indexPrice}\n` +
    `📊 Відхилення: ${Math.abs(spread).toFixed(2)}%\n` +
    `📉 Було відхилення: ${Math.abs(sig.entrySpread).toFixed(2)}%`
  );
}

// ─── ЛОГІКА СПРЕДУ ─────────────────────────────────────────────────────────────
function processInstrument(symbol, markPrice, indexPrice) {
  if (!isNaN(indexPrice) && indexPrice > 0) {
    state.lastIndexPrice.set(symbol, indexPrice);
  } else {
    indexPrice = state.lastIndexPrice.get(symbol) ?? NaN;
  }

  if (isNaN(markPrice) || isNaN(indexPrice) || indexPrice === 0) return;

  state.totalMsgCount++;

  const spread    = ((markPrice - indexPrice) / indexPrice) * 100;
  const absSpread = Math.abs(spread);

  const hasSignal  = state.activeSignals.has(symbol);
  const lastSent   = state.lastSignalTime.get(symbol) || 0;
  const cooldownOk = (Date.now() - lastSent) >= CONFIG.SIGNAL_COOLDOWN_MS;

  // Лог активних сигналів кожні 5 хвилин
  if (Date.now() - state.lastStatsLog > 5 * 60 * 1000) {
    console.log(`[STATS] Messages processed: ${state.totalMsgCount} | Active signals: ${state.activeSignals.size}`);
    if (state.activeSignals.size > 0) {
      for (const [sym, sig] of state.activeSignals) {
        console.log(`  → ${sym} ${sig.direction} entry=${sig.entrySpread.toFixed(3)}% since ${new Date(sig.entryTime).toISOString()}`);
      }
    }
    state.lastStatsLog = Date.now();
  }

  // ── ENTRY ──────────────────────────────────────────────────────────────────
  if (!hasSignal && absSpread >= CONFIG.SPREAD_ENTRY_THRESHOLD && cooldownOk) {
    console.log(`[ENTRY] ${symbol} spread=${spread.toFixed(3)}% mark=${markPrice} idx=${indexPrice}`);
    state.activeSignals.set(symbol, {
      direction:   spread > 0 ? 'SHORT' : 'LONG',
      entryTime:   Date.now(),
      entrySpread: spread,
    });
    state.lastSignalTime.set(symbol, Date.now());
    sendTelegram(formatEntry(symbol, spread, markPrice, indexPrice));
    return;
  }

  // ── EXIT ───────────────────────────────────────────────────────────────────
  if (hasSignal && absSpread <= CONFIG.SPREAD_EXIT_THRESHOLD) {
    const sig = state.activeSignals.get(symbol);
    console.log(`[EXIT]  ${symbol} spread=${spread.toFixed(3)}%`);
    state.activeSignals.delete(symbol);
    sendTelegram(formatExit(symbol, markPrice, indexPrice, spread, sig));
  }
}

// ─── ПАРСИНГ ПОВІДОМЛЕННЯ ──────────────────────────────────────────────────────
// KuCoin може надсилати дані у різних форматах залежно від версії API.
// Ця функція пробує всі відомі варіанти.
function handleDataMessage(msg) {
  const topic   = msg.topic ?? '';
  const subject = msg.subject ?? '';
  const data    = msg.data ?? {};

  // DEBUG: показуємо перші N повідомлень як є
  if (CONFIG.DEBUG_RAW_MESSAGES && state.debugMsgCount < CONFIG.DEBUG_LIMIT) {
    state.debugMsgCount++;
    console.log(`\n[DEBUG MSG #${state.debugMsgCount}]`);
    console.log('  topic:  ', topic);
    console.log('  subject:', subject);
    console.log('  data:   ', JSON.stringify(data));
  }

  // Варіант 1: subject === 'mark.index.price'  (стандарт /contract/instrument)
  // Варіант 2: subject === 'mark.index.price.v2' (деякі версії)
  // Варіант 3: окремий топік /contract/markPrice:{symbol}
  const isMarkIndex = (
    subject === 'mark.index.price' ||
    subject === 'mark.index.price.v2' ||
    subject === 'markIndexPrice' ||
    topic.includes('/contract/markPrice') ||
    topic.includes('/contract/instrument')
  );

  if (!isMarkIndex) return;

  // Витягуємо символ — KuCoin повертає topic вигляду:
  // '/contract/instrument:BTCUSDTM' (якщо одиночна підписка)
  // '/contract/instrument:BTCUSDTM' (навіть при груповій — кожне повідомлення окремо)
  let symbol = '';
  const topicParts = topic.split(':');
  if (topicParts.length >= 2) {
    // Беремо тільки перший символ якщо раптом прийде кілька через кому
    symbol = topicParts[1].split(',')[0].trim();
  }
  // Фолбек: якщо символ є прямо в data
  if (!symbol && data.symbol) symbol = data.symbol;
  if (!symbol) return;

  // Витягуємо ціни — KuCoin може використовувати різні назви полів
  const markPrice  = parseFloat(data.markPrice  ?? data.price       ?? data.mark       ?? NaN);
  const indexPrice = parseFloat(data.indexPrice ?? data.indexPrice  ?? data.index      ?? NaN);

  if (isNaN(markPrice) && isNaN(indexPrice)) {
    // Якщо поля зовсім інші — логуємо щоб побачити
    if (CONFIG.DEBUG_RAW_MESSAGES) {
      console.log(`[DEBUG] Unknown data fields for ${symbol}:`, Object.keys(data));
    }
    return;
  }

  processInstrument(symbol, markPrice, indexPrice);
}

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────────
async function getPublicToken() {
  const res = await axios.post(`${CONFIG.KC_FUTURES_REST}/api/v1/bullet-public`);
  if (res.data.code !== '200000') throw new Error(`Token error: ${res.data.msg}`);
  const { token, instanceServers } = res.data.data;
  const server = instanceServers[0];
  return {
    token,
    endpoint:       server.endpoint,
    pingIntervalMs: server.pingInterval,
  };
}

function createConnection(symbols, tokenInfo, connIndex) {
  return new Promise((resolve, reject) => {
    const connectId = randomUUID().replace(/-/g, '');
    const url = `${tokenInfo.endpoint}?token=${tokenInfo.token}&connectId=${connectId}`;

    console.log(`[WS #${connIndex + 1}] Connecting (${symbols.length} symbols)...`);
    const ws = new WebSocket(url);
    let resolved = false;
    let pingTimer = null;

    function startHeartbeat() {
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: Date.now().toString(), type: 'ping' }));
        }
      }, tokenInfo.pingIntervalMs - 2000);
    }

    ws.on('open', () => console.log(`[WS #${connIndex + 1}] Socket opened`));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'welcome') {
          startHeartbeat();

          // Підписуємось — одна підписка на всі символи через кому
          const topic = `/contract/instrument:${symbols.join(',')}`;
          ws.send(JSON.stringify({ id: Date.now().toString(), type: 'subscribe', topic, response: true }));
          console.log(`[WS #${connIndex + 1}] Subscribed topic sent`);

          if (!resolved) { resolved = true; resolve(ws); }
          return;
        }

        if (msg.type === 'pong') return;

        // Підтвердження підписки
        if (msg.type === 'ack') {
          console.log(`[WS #${connIndex + 1}] Subscription ACK received`);
          return;
        }

        if (msg.type === 'message') {
          handleDataMessage(msg);
        }
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
          const newToken = await getPublicToken();
          const newWs = await createConnection(symbols, newToken, connIndex);
          state.connections[connIndex] = newWs;
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
  if (res.data.code !== '200000') throw new Error(`API Error: ${res.data.msg}`);

  const symbols = res.data.data
    .filter(c => c.status === 'Open' && c.settleCurrency === 'USDT')
    .map(c => c.symbol);

  console.log(`[API] Found ${symbols.length} active USDT futures symbols`);
  return symbols;
}

async function initConnections() {
  const chunks = [];
  for (let i = 0; i < state.symbols.length; i += CONFIG.SYMBOLS_PER_SUB) {
    chunks.push(state.symbols.slice(i, i + CONFIG.SYMBOLS_PER_SUB));
  }
  console.log(`[WS] Creating ${chunks.length} connection(s)...`);
  for (let i = 0; i < chunks.length; i++) {
    const tokenInfo = await getPublicToken();
    const ws = await createConnection(chunks[i], tokenInfo, i);
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
  console.log(`[CONFIG] Entry Threshold : ${CONFIG.SPREAD_ENTRY_THRESHOLD}%`);
  console.log(`[CONFIG] Exit  Threshold : ${CONFIG.SPREAD_EXIT_THRESHOLD}%`);
  console.log(`[CONFIG] Signal Cooldown : ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`);
  console.log(`[CONFIG] Debug mode      : ${CONFIG.DEBUG_RAW_MESSAGES}`);
  console.log('='.repeat(60));

  state.symbols = await fetchSymbols();
  await initConnections();

  console.log('[BOT] ✅ Monitoring spreads...');
  if (CONFIG.DEBUG_RAW_MESSAGES) {
    console.log(`[DEBUG] Will log first ${CONFIG.DEBUG_LIMIT} raw messages to inspect KuCoin data structure`);
  }

  sendTelegram(
    `🤖 <b>KUCOIN SPREAD MONITOR STARTED</b>\n\n` +
    `Моніторинг: ${state.symbols.length} USDT ф'ючерсів\n` +
    `Поріг входу: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%\n` +
    `Поріг виходу: ${CONFIG.SPREAD_EXIT_THRESHOLD}%`
  );
}

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Shutting down...');
  state.connections.forEach((ws, i) => {
    if (ws?.readyState === WebSocket.OPEN) { ws.close(); }
  });
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '🛑 <b>KUCOIN SPREAD MONITOR STOPPED</b>', { parse_mode: 'HTML' })
    .finally(() => process.exit(0));
});

process.on('SIGTERM', () => process.exit(0));

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
