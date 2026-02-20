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

  // Мінімальна пауза між повторними Entry-сповіщеннями для одного символу
  SIGNAL_COOLDOWN_MS: parseInt(process.env.SIGNAL_COOLDOWN_MS || '60000'),

  // KuCoin Futures REST (для отримання токена і списку символів)
  KC_FUTURES_REST: 'https://api-futures.kucoin.com',

  // Максимум символів у одному рядку підписки (KuCoin обмеження — 100 топіків/з'єднання)
  SYMBOLS_PER_SUB: parseInt(process.env.SYMBOLS_PER_SUB || '50'),

  // Reconnect затримка при обриві
  RECONNECT_DELAY_MS: 5_000,
};

if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('[ERROR] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// ─── STATE ─────────────────────────────────────────────────────────────────────
const tg = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);

const state = {
  symbols:         [],
  activeSignals:   new Map(), // symbol → { direction, entryTime, entrySpread, markPrice, indexPrice }
  lastSignalTime:  new Map(), // symbol → timestamp (cooldown)
  lastIndexPrice:  new Map(), // symbol → indexPrice (кеш — на випадок пропуску поля)
  connections:     [],        // масив активних WS-з'єднань
};

// ─── TELEGRAM ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' })
    .catch(err => console.error('[TG] Error:', err.message));
}

// ─── ФОРМАТУВАННЯ СИГНАЛІВ (точно як у прикладі) ───────────────────────────────
function formatEntry(symbol, spread, markPrice, indexPrice) {
  const direction = markPrice < indexPrice ? '🟢' : '🔴';
  const now = new Date();
  const timeStr = now.toISOString().replace('T', ' ').replace('Z', '') + ' UTC';
  const millisStr = now.toISOString().slice(11, 23) + ' UTC';

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
  const timeStr = `${secs} сек ${ms} мс`;

  return (
    `✅ <b>${symbol} - Ціни зрівнялись!</b>\n\n` +
    `⏱️ Через: ${timeStr}\n` +
    `💰 Остання ціна: ${markPrice}\n` +
    `⚖️ Справедлива: ${indexPrice}\n` +
    `📊 Відхилення: ${Math.abs(spread).toFixed(2)}%\n` +
    `📉 Було відхилення: ${Math.abs(sig.entrySpread).toFixed(2)}%`
  );
}

// ─── ЛОГІКА СПРЕДУ ─────────────────────────────────────────────────────────────
function processInstrument(symbol, markPrice, indexPrice) {
  // Кешуємо indexPrice (іноді може бути відсутній)
  if (!isNaN(indexPrice) && indexPrice > 0) {
    state.lastIndexPrice.set(symbol, indexPrice);
  } else {
    indexPrice = state.lastIndexPrice.get(symbol) ?? NaN;
  }

  if (isNaN(markPrice) || isNaN(indexPrice) || indexPrice === 0) return;

  const spread    = ((markPrice - indexPrice) / indexPrice) * 100;
  const absSpread = Math.abs(spread);

  const hasSignal  = state.activeSignals.has(symbol);
  const lastSent   = state.lastSignalTime.get(symbol) || 0;
  const cooldownOk = (Date.now() - lastSent) >= CONFIG.SIGNAL_COOLDOWN_MS;

  // ── ENTRY ──────────────────────────────────────────────────────────────────
  if (!hasSignal && absSpread >= CONFIG.SPREAD_ENTRY_THRESHOLD && cooldownOk) {
    console.log(`[ENTRY] ${symbol} spread=${spread.toFixed(3)}% mark=${markPrice} idx=${indexPrice}`);

    state.activeSignals.set(symbol, {
      direction:   spread > 0 ? 'SHORT' : 'LONG',
      entryTime:   Date.now(),
      entrySpread: spread,
      markPrice,
      indexPrice,
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

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────────
/**
 * KuCoin вимагає отримати токен перед підключенням.
 * Публічний токен — без API Key, безкоштовно.
 */
async function getPublicToken() {
  const res = await axios.post(`${CONFIG.KC_FUTURES_REST}/api/v1/bullet-public`);
  if (res.data.code !== '200000') throw new Error(`Token error: ${res.data.msg}`);

  const { token, instanceServers } = res.data.data;
  const server = instanceServers[0]; // беремо перший сервер

  return {
    token,
    endpoint:        server.endpoint,
    pingIntervalMs:  server.pingInterval, // зазвичай 18000 (18с)
    pingTimeoutMs:   server.pingTimeout,  // зазвичай 10000 (10с)
  };
}

/**
 * Створює одне WS-з'єднання для масиву символів.
 */
function createConnection(symbols, tokenInfo, connIndex) {
  return new Promise((resolve, reject) => {
    const connectId = randomUUID().replace(/-/g, '');
    const url = `${tokenInfo.endpoint}?token=${tokenInfo.token}&connectId=${connectId}`;

    console.log(`[WS #${connIndex + 1}] Connecting (${symbols.length} symbols)...`);
    const ws = new WebSocket(url);
    let resolved = false;
    let pingTimer = null;

    // ── Heartbeat ──────────────────────────────────────────────────────────
    function startHeartbeat() {
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: Date.now().toString(), type: 'ping' }));
        }
      }, tokenInfo.pingIntervalMs - 2000); // на 2с раніше для надійності
    }

    ws.on('open', () => {
      console.log(`[WS #${connIndex + 1}] Connected`);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Welcome → підписуємось одразу після підключення
        if (msg.type === 'welcome') {
          startHeartbeat();

          // Підписуємось одним рядком: /contract/instrument:SYM1,SYM2,...
          const topic = `/contract/instrument:${symbols.join(',')}`;
          ws.send(JSON.stringify({
            id:       Date.now().toString(),
            type:     'subscribe',
            topic,
            response: true,
          }));
          console.log(`[WS #${connIndex + 1}] Subscribed to ${symbols.length} instruments`);

          if (!resolved) { resolved = true; resolve(ws); }
          return;
        }

        // Pong відповідь — нічого не робимо
        if (msg.type === 'pong') return;

        // Дані mark+index price
        if (
          msg.type    === 'message' &&
          msg.subject === 'mark.index.price' &&
          msg.data
        ) {
          const symbol     = msg.topic.split(':')[1];
          const markPrice  = parseFloat(msg.data.markPrice);
          const indexPrice = parseFloat(msg.data.indexPrice);
          processInstrument(symbol, markPrice, indexPrice);
        }
      } catch (err) {
        console.error(`[WS #${connIndex + 1}] Parse error:`, err.message);
      }
    });

    ws.on('error', err => {
      console.error(`[WS #${connIndex + 1}] Error:`, err.message);
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      console.log(`[WS #${connIndex + 1}] Closed. Reconnecting in ${CONFIG.RECONNECT_DELAY_MS}ms...`);

      setTimeout(async () => {
        try {
          const newTokenInfo = await getPublicToken(); // токен одноразовий, беремо новий
          const newWs = await createConnection(symbols, newTokenInfo, connIndex);
          state.connections[connIndex] = newWs;
        } catch (err) {
          console.error(`[RECONNECT #${connIndex + 1}] Failed:`, err.message);
        }
      }, CONFIG.RECONNECT_DELAY_MS);
    });

    setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error(`Connection #${connIndex + 1} timeout`)); }
    }, 30_000);
  });
}

// ─── ІНІЦІАЛІЗАЦІЯ ─────────────────────────────────────────────────────────────
async function fetchSymbols() {
  console.log('[API] Fetching active USDT futures symbols from KuCoin...');
  const res = await axios.get(`${CONFIG.KC_FUTURES_REST}/api/v1/contracts/active`);

  if (res.data.code !== '200000') throw new Error(`API Error: ${res.data.msg}`);

  const symbols = res.data.data
    .filter(c => c.status === 'Open' && c.settleCurrency === 'USDT')
    .map(c => c.symbol);

  console.log(`[API] Found ${symbols.length} active USDT futures symbols`);
  return symbols;
}

async function initConnections() {
  const symbols = state.symbols;
  const chunkSize = CONFIG.SYMBOLS_PER_SUB;
  const chunks = [];

  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }

  console.log(`[WS] Creating ${chunks.length} connection(s) (~${chunkSize} symbols each)...`);

  for (let i = 0; i < chunks.length; i++) {
    const tokenInfo = await getPublicToken();
    const ws = await createConnection(chunks[i], tokenInfo, i);
    state.connections.push(ws);

    // Невелика затримка між з'єднаннями щоб не флудити
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
  console.log(`[CONFIG] Symbols/conn    : ${CONFIG.SYMBOLS_PER_SUB}`);
  console.log('='.repeat(60));

  state.symbols = await fetchSymbols();
  await initConnections();

  console.log('[BOT] ✅ Monitoring spreads...');

  sendTelegram(
    `🤖 <b>KUCOIN SPREAD MONITOR STARTED</b>\n\n` +
    `Моніторинг: ${state.symbols.length} USDT ф'ючерсів\n` +
    `Поріг входу: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%\n` +
    `Поріг виходу: ${CONFIG.SPREAD_EXIT_THRESHOLD}%\n` +
    `Cooldown: ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`
  );
}

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Shutting down...');
  state.connections.forEach((ws, i) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close();
      console.log(`[SHUTDOWN] Closed connection #${i + 1}`);
    }
  });
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '🛑 <b>KUCOIN SPREAD MONITOR STOPPED</b>', { parse_mode: 'HTML' })
    .finally(() => process.exit(0));
});

process.on('SIGTERM', () => process.exit(0));

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
