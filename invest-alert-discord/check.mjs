import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const WATCHLIST_FILE = path.join(ROOT, 'watchlist.json');
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const AVG_SESSIONS = Number.parseInt(process.env.AVG_SESSIONS || '60', 10);
const ALERT_STEP_PERCENT = Number.parseFloat(process.env.ALERT_STEP_PERCENT || '1');

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function isMarketWindow(now = new Date()) {
  if (process.env.FORCE_RUN === 'true') return true;
  const p = localParts(now);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(p.weekday);
  const hour = Number(p.hour);
  return weekday && hour >= 10 && hour <= 17;
}

function dateInTimezone(epochSeconds, timezone = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(epochSeconds * 1000));
}

export function average(values) {
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function money(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL'
  }).format(value);
}

function percent(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(value);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function fetchQuote(asset) {
  const url = new URL(`https://brapi.dev/api/quote/${encodeURIComponent(asset.symbol)}`);
  url.searchParams.set('range', '3mo');
  url.searchParams.set('interval', '1d');
  const headers = {};
  if (process.env.BRAPI_TOKEN) headers.Authorization = `Bearer ${process.env.BRAPI_TOKEN}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${asset.symbol}: API respondeu HTTP ${response.status}`);
  const payload = await response.json();
  const quote = payload.results?.[0];
  if (!quote || !Number.isFinite(Number(quote.regularMarketPrice))) {
    throw new Error(`${asset.symbol}: cotação não encontrada na resposta`);
  }
  return { quote, requestedAt: payload.requestedAt };
}

function marketDataTimestamp(quote) {
  const t = quote.regularMarketTime ? new Date(quote.regularMarketTime) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

function historicalCloses(quote, now) {
  const today = localParts(now).year + '-' + localParts(now).month + '-' + localParts(now).day;
  const rows = quote.historicalDataPrice || [];
  return rows
    .filter(row => Number.isFinite(Number(row.close)) && Number.isFinite(Number(row.date)))
    .map(row => ({
      date: dateInTimezone(Number(row.date)),
      close: Number(row.close)
    }))
    // Compare the live quote against completed sessions only; never include today's partial candle.
    .filter(row => row.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function shouldAlert(price, mean, previousAlertPrice, stepPercent) {
  if (!(price < mean)) return false;
  if (!Number.isFinite(previousAlertPrice)) return true;
  return price <= previousAlertPrice * (1 - stepPercent / 100);
}

async function postDiscord(content) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error('Falta configurar DISCORD_WEBHOOK_URL.');
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Radar de Investimentos', content }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Discord respondeu HTTP ${response.status}`);
}

export async function run({ now = new Date() } = {}) {
  if (!isMarketWindow(now)) {
    console.log('Fora do horário programado; nenhuma consulta foi feita.');
    return { sent: false, reason: 'outside-market-window' };
  }
  if (!Number.isInteger(AVG_SESSIONS) || AVG_SESSIONS < 2) {
    throw new Error('AVG_SESSIONS precisa ser um número inteiro maior que 1.');
  }

  const watchlist = await readJson(WATCHLIST_FILE, []);
  const state = await readJson(STATE_FILE, {});
  const alerts = [];
  const errors = [];

  for (const asset of watchlist) {
    try {
      const { quote } = await fetchQuote(asset);
      const price = Number(quote.regularMarketPrice);
      const time = marketDataTimestamp(quote);
      const history = historicalCloses(quote, now);
      const key = asset.symbol.toUpperCase();

      // Keep dated closes in the repository state to preserve a consistent moving window.
      const cached = state[key]?.history || [];
      const byDate = new Map([...cached, ...history].map(row => [row.date, row.close]));
      state[key] = state[key] || {};
      state[key].history = [...byDate.entries()]
        .map(([date, close]) => ({ date, close }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-AVG_SESSIONS);

      const closes = state[key].history.slice(-AVG_SESSIONS).map(row => row.close);
      if (closes.length < AVG_SESSIONS) {
        console.log(`${key}: aguardando histórico (${closes.length}/${AVG_SESSIONS} pregões).`);
        continue;
      }
      const mean = average(closes);
      const currentDay = localParts(now).year + '-' + localParts(now).month + '-' + localParts(now).day;
      const quoteDay = time ? dateInTimezone(time.getTime() / 1000) : null;
      if (!time || quoteDay !== currentDay) {
        console.log(`${key}: cotação ainda não atualizada para hoje; ignorada.`);
        continue;
      }

      const lastAlert = Number(state[key].lastAlertPrice);
      if (price >= mean) {
        state[key].lastAlertPrice = null;
        continue;
      }
      if (shouldAlert(price, mean, lastAlert, ALERT_STEP_PERCENT)) {
        const below = (mean - price) / mean;
        alerts.push({
          name: asset.name || key,
          symbol: key,
          price,
          mean,
          below,
          quoteTime: time.toLocaleTimeString('pt-BR', {
            timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit'
          })
        });
        state[key].lastAlertPrice = price;
      }
    } catch (error) {
      errors.push(error.message);
      console.error(error.message);
    }
  }

  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

  if (alerts.length) {
    const lines = alerts.map(item =>
      `• **${item.name} (${item.symbol})**: ${money(item.price)} | média ${AVG_SESSIONS} pregões: ${money(item.mean)} | ${percent(item.below)} abaixo | cotação ${item.quoteTime}`
    );
    await postDiscord(`📉 **Ativo abaixo da média histórica**\n${lines.join('\n')}\n\nAlerta automático para análise; não é recomendação de compra.`);
  }
  if (errors.length && !alerts.length) {
    console.log(`${errors.length} ativo(s) tiveram erro; nenhum alerta enviado.`);
  }
  console.log(alerts.length ? `${alerts.length} alerta(s) publicado(s).` : 'Sem novas quedas que atinjam os critérios.');
  return { sent: alerts.length > 0, alerts, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
