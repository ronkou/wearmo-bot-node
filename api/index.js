const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();

app.use(express.json());

// ========== 環境變數 ==========
const MONGODB_URI     = process.env.MONGODB_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;

// 企業微信（已棄用，改用 Telegram）
const BOT_ID     = process.env.BOT_ID;
const BOT_SECRET = process.env.BOT_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// ========== MongoDB（Serverless 安全連接） ==========
let mongoConnected = false;

async function ensureMongo() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 10000,
    });
  }
  mongoConnected = true;
}

// ========== 任務模型 ==========
const TaskSchema = new mongoose.Schema({
  itemId:       String,
  targetPrice:  Number,
  title:        String,
  finished:     { type: Boolean, default: false },
  createdAt:    { type: Date, default: Date.now }
});
const Task = mongoose.model('Task', TaskSchema);

// ========== 發送 Telegram 消息 ==========
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️ Telegram 未配置（TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
    console.log('✅ Telegram 通知已發送');
  } catch (e) {
    console.error('❌ Telegram 發送失敗:', e.response?.data || e.message);
  }
}

// ========== Yahoo JSON 接口 ==========
async function getYahooPrice(itemId) {
  const url = `https://auctions.yahoo.co.jp/jp/auction/${itemId}?format=json`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 12000
  });
  return { price: parseInt(res.data.price), title: res.data.title };
}

// ========== 處理指令 ==========
async function handleCommand(content) {
  const parts = content.trim().split(/\s+/);

  if (parts.length >= 3 && parts[0] === '監測') {
    const itemId = parts[1];
    const target = parseInt(parts[2]);
    try {
      const { price, title } = await getYahooPrice(itemId);
      await Task.create({ itemId, targetPrice: target, title });
      await sendTelegram(
        `✅ 已開始監測\n商品：${title}\n當前價：${price}円\n目標價：${target}円\n👉 <a href="https://auctions.yahoo.co.jp/jp/auction/${itemId}">查看拍賣</a>`
      );
    } catch (e) {
      console.error('Yahoo 失敗:', e.message);
      await sendTelegram('❌ 商品獲取失敗，請檢查 ID 是否正確');
    }
    return;
  }

  if (content.trim() === '列表') {
    const tasks = await Task.find({ finished: false }).limit(10);
    if (!tasks.length) { await sendTelegram('📋 暫無進行中的任務'); return; }
    const lines = tasks.map(t => `${t.itemId} | 目標：${t.targetPrice}円`);
    await sendTelegram('📋 進行中的任務：\n' + lines.join('\n'));
    return;
  }

  if (content.trim() === '停止') {
    await Task.deleteMany({ finished: false });
    await sendTelegram('🗑️ 已清除所有監測任務');
    return;
  }

  await sendTelegram('❓ 未知指令\n支援：\n監測 商品ID 目標價格\n列表\n停止');
}

// ========== 企業微信長輪詢 ==========
let seq = 0;

async function longPoll() {
  try {
    // 1. 取 token
    const tokenRes = await axios.post(
      'https://qyapi.weixin.qq.com/cgi-bin/bot/get_token',
      { bot_id: BOT_ID, secret: BOT_SECRET },
      { timeout: 10000 }
    );
    const token = tokenRes.data.access_token;
    if (!token) { console.error('❌ 無 access_token:', tokenRes.data); return; }

    // 2. 長輪詢拉消息
    const pollRes = await axios.post(
      `https://qyapi.weixin.qq.com/cgi-bin/bot/longpoll?access_token=${token}`,
      { timeout: 30, seq },
      { timeout: 35000 }
    );

    const msgs = pollRes.data.msg_list || [];
    console.log(`📥 收到消息 ${msgs.length} 條`);
    for (const m of msgs) {
      if (m.msg_type === 'text' && m.content) {
        await handleCommand(m.content);
      }
    }
    if (pollRes.data.seq) seq = pollRes.data.seq;

  } catch (e) {
    console.error('❌ 長輪詢錯誤:', e.response?.data || e.message);
  } finally {
    setTimeout(longPoll, 1000);
  }
}

// ========== 定時檢查（cron） ==========
async function checkPrices() {
  try {
    await ensureMongo();
    const tasks = await Task.find({ finished: false });
    console.log(`🔍 檢查 ${tasks.length} 個任務`);
    for (const t of tasks) {
      try {
        const { price } = await getYahooPrice(t.itemId);
        if (price <= t.targetPrice) {
          await sendTelegram(
            `🔥 價格達標！\n${t.title}\n現價：${price}円\n目標：${t.targetPrice}円\n👉 <a href="https://auctions.yahoo.co.jp/jp/auction/${t.itemId}">查看拍賣</a>`
          );
          t.finished = true;
          await t.save();
        }
      } catch (e) {
        console.error(`❌ ${t.itemId} 失敗:`, e.message);
      }
    }
  } catch (e) {
    console.error('❌ cron 執行失敗:', e.message);
  }
}

// ========== HTTP 路由 ==========
app.get('/', (req, res) => res.send('✅ 機器人運行中'));

app.get('/api/cron', async (req, res) => {
  try {
    await checkPrices();
    res.json({ ok: true, time: new Date().toISOString() });
  } catch (e) {
    console.error('❌ /api/cron 失敗:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  await ensureMongo().catch(() => {});
  res.json({ status: 'healthy', service: 'yahoo-auction-monitor', telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) });
});

// ========== Telegram 指令接口（Vercel / HTTP 觸發） ==========
app.get('/api/cmd', async (req, res) => {
  const { cmd } = req.query;
  if (!cmd) { res.json({ ok: false, msg: '缺少 cmd 參數' }); return; }
  try {
    await ensureMongo();
    await handleCommand(cmd);
    res.json({ ok: true });
  } catch (e) {
    console.error('cmd 失敗:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========== 啟動（本地 / Vercel） ==========
const PORT = process.env.PORT || 3000;
if (process.env.VERCEL !== '1') {
  // 本地模式：長輪詢 + 定時檢查
  app.listen(PORT, async () => {
    console.log(`🚀 啟動 (Port ${PORT})`);
    await ensureMongo();
    // longPoll(); // Telegram Bot 不需要本地長輪詢，交給 cron 處理
    setInterval(checkPrices, 60000);
  });
}

module.exports = app;
