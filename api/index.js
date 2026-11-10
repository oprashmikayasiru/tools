const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

const BOT_TOKEN = process.env.BOT_TOKEN || '9251791914:AAHG26G5mVVShsQpF8PK1fvpWgmZ__FNPCk';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oprashmikayasiru_db_user:AMcK5sVpxXr3R7VT@cluster0.ulukf3s.mongodb.net/vibelk_tools_db?retryWrites=true&w=majority';
const ADMIN_ID = Number(process.env.ADMIN_ID) || 5411921025;

const SOURCE_CHANNEL_ID = -1004309315754; // Hot Lanka V2
const TARGET_CHANNEL_ID = -1004472514921; // VibeLK 🔥

const bot = new Telegraf(BOT_TOKEN);

let cachedDb = null;
let clientPromise = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  cachedDb = client.db('vibelk_tools_db');
  return cachedDb;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getConfig(db) {
  let cfg = await db.collection('settings').findOne({ _id: 'main_config' });
  if (!cfg) {
    cfg = {
      _id: 'main_config',
      is_active: true,
      batch_size: 5,
      schedule_times: ['05:00', '20:00'],
      last_message_id: 7,
      is_posting_locked: false,
      last_posted_hour: null,
      approved_channels: [
        { id: SOURCE_CHANNEL_ID, title: 'Hot Lanka V2' },
        { id: TARGET_CHANNEL_ID, title: 'VibeLK 🔥' }
      ]
    };
    await db.collection('settings').insertOne(cfg);
  }
  return cfg;
}

// Single Post Direct Copy Function
async function copySingleMessage(msgId) {
  const copied = await bot.telegram.copyMessage(
    TARGET_CHANNEL_ID,
    SOURCE_CHANNEL_ID,
    msgId
  );

  if (copied && copied.caption) {
    const originalCaption = copied.caption;
    const rebrandedCaption = originalCaption.replace(/Hot Lanka/gi, 'VibeLK');
    if (rebrandedCaption !== originalCaption) {
      await bot.telegram.editMessageCaption(
        TARGET_CHANNEL_ID,
        copied.message_id,
        undefined,
        rebrandedCaption,
        { parse_mode: 'HTML' }
      ).catch(async () => {
        await bot.telegram.editMessageCaption(
          TARGET_CHANNEL_ID,
          copied.message_id,
          undefined,
          rebrandedCaption
        ).catch(() => {});
      });
    }
  }
  return copied;
}

// Posting Worker
async function runPostingBatch(db, manualTrigger = false) {
  const cfg = await getConfig(db);
  if (!cfg.is_active && !manualTrigger) return;

  const lockAcquired = await db.collection('settings').updateOne(
    { _id: 'main_config', is_posting_locked: { $ne: true } },
    { $set: { is_posting_locked: true } }
  );

  if (lockAcquired.matchedCount === 0) {
    if (ADMIN_ID && manualTrigger) {
      await bot.telegram.sendMessage(ADMIN_ID, '⚠️ Loop already running! Use /unlock to reset.').catch(() => {});
    }
    return;
  }

  let currentMsgId = cfg.last_message_id || 7;
  let postedCount = 0;
  const targetCount = cfg.batch_size || 5;
  let errorLog = '';

  try {
    while (postedCount < targetCount && currentMsgId < (cfg.last_message_id + 50)) {
      try {
        await copySingleMessage(currentMsgId);

        await db.collection('processed_posts').insertOne({
          _id: currentMsgId,
          posted_at: new Date()
        }).catch(() => {});

        postedCount++;

        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          { $set: { last_message_id: currentMsgId + 1 } }
        );

        await sleep(500);
      } catch (err) {
        errorLog = err.message;
      }
      currentMsgId++;
    }

    if (ADMIN_ID) {
      if (postedCount > 0) {
        await bot.telegram.sendMessage(
          ADMIN_ID,
          `✅ <b>Batch Completed:</b> ${postedCount} posts published to VibeLK!\n📌 Next ID: #${currentMsgId}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      } else {
        await bot.telegram.sendMessage(
          ADMIN_ID,
          `⚠️ 0 posts copied.\nLast error: <code>${errorLog || 'None'}</code>\nScanned ID: #${currentMsgId}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }
  } finally {
    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { $set: { is_posting_locked: false } }
    );
  }
}

// --- Join Request ---
bot.on('chat_join_request', async (ctx) => {
  try {
    const db = await getDb();
    const cfg = await getConfig(db);
    const incomingChatId = ctx.chatJoinRequest.chat.id;

    const isApproved = (cfg.approved_channels || []).some(
      (c) => String(c.id) === String(incomingChatId)
    );

    if (isApproved) {
      await ctx.telegram.approveChatJoinRequest(
        incomingChatId,
        ctx.chatJoinRequest.from.id
      );
    }
  } catch (e) {}
});

// --- Direct Test Command: /testpost ---
bot.command('testpost', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply('⏳ Trying to copy Message ID 7 right now...');
  try {
    const res = await copySingleMessage(7);
    await ctx.reply(`🎉 SUCCESS! Message copied to VibeLK (New ID: ${res.message_id})`);
  } catch (err) {
    await ctx.reply(`❌ FAILED!\nError: ${err.message}\n\nCheck:\n1. Is Bot an Admin in both channels?\n2. Does Bot have 'Post Messages' rights in VibeLK?`);
  }
});

// Admin Panel Helpers
function getAdminKeyboard(cfg) {
  const statusIcon = cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED';
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Post Now', 'admin_post_now')],
    [
      Markup.button.callback(`📦 Batch: ${cfg.batch_size}`, 'admin_ui_batch'),
      Markup.button.callback('⏰ Set Times', 'admin_ui_times')
    ],
    [
      Markup.button.callback('📢 Channels', 'admin_ui_channels'),
      Markup.button.callback(`Status: ${statusIcon}`, 'admin_toggle_status')
    ],
    [Markup.button.callback('🔄 Refresh', 'admin_refresh')]
  ]);
}

function renderAdminText(cfg) {
  const timesStr = (cfg.schedule_times || []).join(', ') || 'None';
  const channelsCount = (cfg.approved_channels || []).length;
  return `⚙️ <b>TOOLS CONTROL</b>\n\n` +
    `📊 <b>Status:</b> ${cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
    `📦 <b>Batch:</b> ${cfg.batch_size} Posts\n` +
    `⏰ <b>Schedule:</b> ${timesStr}\n` +
    `📢 <b>Auto-Approve:</b> ${channelsCount} Channels\n` +
    `📌 <b>Current Msg ID:</b> #${cfg.last_message_id || 7}`;
}

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.replyWithHTML(renderAdminText(cfg), getAdminKeyboard(cfg));
});

bot.command('unlock', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { is_posting_locked: false } }
  );
  await ctx.reply('🔓 Lock cleared.');
});

bot.command('setid', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.split(' ');
  const newId = parseInt(parts[1], 10);
  if (isNaN(newId)) return ctx.reply('Usage: /setid 7');
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { last_message_id: newId, is_posting_locked: false } }
  );
  await ctx.reply(`✅ Next Message ID set to #${newId}`);
});

bot.action('admin_refresh', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(renderAdminText(cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery('Refreshed');
});

bot.action('admin_toggle_status', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { is_active: !cfg.is_active } }
  );
  cfg.is_active = !cfg.is_active;
  await ctx.editMessageText(renderAdminText(cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('admin_post_now', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.answerCbQuery('🚀 Starting batch...');
  const db = await getDb();
  runPostingBatch(db, true);
});

// Gateway
module.exports = async (req, res) => {
  try {
    const db = await getDb();

    if (req.method === 'GET') {
      res.status(200).json({ ok: true });
      const now = new Date();
      const slDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const hours = String(slDate.getUTCHours()).padStart(2, '0');
      const timeKey = `${hours}:00`;

      const cfg = await getConfig(db);
      if (
        cfg.is_active &&
        (cfg.schedule_times || []).includes(timeKey) &&
        cfg.last_posted_hour !== timeKey
      ) {
        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          { $set: { last_posted_hour: timeKey } }
        );
        runPostingBatch(db, false);
      }
      return;
    }

    if (req.method === 'POST' && req.body) {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false });
  }
};
