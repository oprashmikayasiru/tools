const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

// --- Configurations & Credentials ---
const BOT_TOKEN = process.env.BOT_TOKEN || '9251791914:AAHG26G5mVVShsQpF8PK1fvpWgmZ__FNPCk';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oprashmikayasiru_db_user:AMcK5sVpxXr3R7VT@cluster0.ulukf3s.mongodb.net/vibelk_tools_db?retryWrites=true&w=majority';
const ADMIN_ID = Number(process.env.ADMIN_ID) || 5411921025;

// Channel Mappings
const SOURCE_CHANNEL_ID = -1004309315754; // Hot Lanka V2
const TARGET_CHANNEL_ID = -1004472514921; // VibeLK 🔥

const bot = new Telegraf(BOT_TOKEN);

// --- Mongo Connection Caching ---
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
      last_message_id: 8,
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

// --- No-Forward-Tag Button Preserver Function ---
async function copyWithExtractedButtons(msgId) {
  // Step 1: Forward quietly to Admin to read the internal Telegram markup payload
  const forwarded = await bot.telegram.forwardMessage(
    ADMIN_ID,
    SOURCE_CHANNEL_ID,
    msgId,
    { disable_notification: true }
  );

  // Extract Buttons & Caption
  const originalMarkup = forwarded.reply_markup || undefined;
  let caption = forwarded.caption || forwarded.text || '';
  if (caption) {
    caption = caption.replace(/Hot Lanka/gi, 'VibeLK');
  }

  const extraOptions = {
    caption: caption,
    parse_mode: 'HTML',
    reply_markup: originalMarkup
  };

  let targetMsg = null;

  // Step 2: Direct Post to Target without any forward tag based on media type
  if (forwarded.photo && forwarded.photo.length > 0) {
    const highestPhoto = forwarded.photo[forwarded.photo.length - 1].file_id;
    targetMsg = await bot.telegram.sendPhoto(TARGET_CHANNEL_ID, highestPhoto, extraOptions);
  } else if (forwarded.video) {
    targetMsg = await bot.telegram.sendVideo(TARGET_CHANNEL_ID, forwarded.video.file_id, extraOptions);
  } else if (forwarded.document) {
    targetMsg = await bot.telegram.sendDocument(TARGET_CHANNEL_ID, forwarded.document.file_id, extraOptions);
  } else if (forwarded.animation) {
    targetMsg = await bot.telegram.sendAnimation(TARGET_CHANNEL_ID, forwarded.animation.file_id, extraOptions);
  } else if (forwarded.text) {
    targetMsg = await bot.telegram.sendMessage(TARGET_CHANNEL_ID, caption, {
      parse_mode: 'HTML',
      reply_markup: originalMarkup
    });
  } else {
    // Fallback direct copy
    targetMsg = await bot.telegram.copyMessage(TARGET_CHANNEL_ID, SOURCE_CHANNEL_ID, msgId, {
      caption: caption,
      reply_markup: originalMarkup
    });
  }

  // Step 3: Delete temporary inspection forward from Admin chat
  await bot.telegram.deleteMessage(ADMIN_ID, forwarded.message_id).catch(() => {});

  return targetMsg;
}

// --- Batch Worker Execution ---
async function runPostingBatch(db, manualTrigger = false) {
  const cfg = await getConfig(db);
  if (!cfg.is_active && !manualTrigger) return { posted: 0 };

  let currentMsgId = cfg.last_message_id || 8;
  let postedCount = 0;
  const targetCount = cfg.batch_size || 5;
  let consecutiveErrors = 0;
  const maxScanLimit = currentMsgId + 100;

  while (postedCount < targetCount && currentMsgId < maxScanLimit) {
    const isAlreadyProcessed = await db.collection('processed_posts').findOne({ _id: currentMsgId });
    if (isAlreadyProcessed) {
      currentMsgId++;
      continue;
    }

    try {
      await copyWithExtractedButtons(currentMsgId);

      await db.collection('processed_posts').insertOne({
        _id: currentMsgId,
        posted_at: new Date()
      }).catch(() => {});

      postedCount++;
      consecutiveErrors = 0;

      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $set: { last_message_id: currentMsgId + 1 } }
      );

      await sleep(500);
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors > 25) break;
    }
    currentMsgId++;
  }

  return { posted: postedCount, nextId: currentMsgId };
}

// --- Universal Auto-Approval Listener ---
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

// --- Admin Dashboard UI Helpers ---
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
    `📌 <b>Current Msg ID:</b> #${cfg.last_message_id || 8}`;
}

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.replyWithHTML(renderAdminText(cfg), getAdminKeyboard(cfg));
});

bot.command('setid', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.split(' ');
  const newId = parseInt(parts[1], 10);
  if (isNaN(newId)) return ctx.reply('Usage: /setid <number>');
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { last_message_id: newId } }
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
  await ctx.answerCbQuery('🚀 Starting batch with buttons...');
  const db = await getDb();
  
  const result = await runPostingBatch(db, true);
  const cfg = await getConfig(db);

  await ctx.editMessageText(renderAdminText(cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});

  if (result.posted > 0) {
    await ctx.reply(`✅ <b>Success!</b> ${result.posted} posts published to VibeLK with buttons! 🔥\n📌 Next Message ID: #${result.nextId}`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(`⚠️ No new posts were found starting from ID #${cfg.last_message_id}.`);
  }
});

// UI: Time Selection
bot.action('admin_ui_times', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  const activeTimes = cfg.schedule_times || [];

  const is5 = activeTimes.includes('05:00');
  const is15 = activeTimes.includes('15:00');
  const is20 = activeTimes.includes('20:00');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`🌅 Morning (05:00 AM) ${is5 ? '✅' : '▫️'}`, 'toggle_time_05:00')],
    [Markup.button.callback(`🌇 Evening (03:00 PM) ${is15 ? '✅' : '▫️'}`, 'toggle_time_15:00')],
    [Markup.button.callback(`🌙 Night (08:00 PM)   ${is20 ? '✅' : '▫️'}`, 'toggle_time_20:00')],
    [Markup.button.callback('🔙 Back', 'admin_refresh')]
  ]);

  await ctx.editMessageText('⏰ <b>SELECT POSTING TIMES</b>\nTap to toggle ON/OFF:', {
    parse_mode: 'HTML',
    ...kb
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action(/toggle_time_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const selectedTime = ctx.match[1];
  const db = await getDb();
  const cfg = await getConfig(db);
  let times = cfg.schedule_times || [];

  times = times.includes(selectedTime) ? times.filter((t) => t !== selectedTime) : [...times, selectedTime];

  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { schedule_times: times } }
  );

  const is5 = times.includes('05:00');
  const is15 = times.includes('15:00');
  const is20 = times.includes('20:00');

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`🌅 Morning (05:00 AM) ${is5 ? '✅' : '▫️'}`, 'toggle_time_05:00')],
    [Markup.button.callback(`🌇 Evening (03:00 PM) ${is15 ? '✅' : '▫️'}`, 'toggle_time_15:00')],
    [Markup.button.callback(`🌙 Night (08:00 PM)   ${is20 ? '✅' : '▫️'}`, 'toggle_time_20:00')],
    [Markup.button.callback('🔙 Back', 'admin_refresh')]
  ]);

  await ctx.editMessageText('⏰ <b>SELECT POSTING TIMES</b>\nTap to toggle ON/OFF:', {
    parse_mode: 'HTML',
    ...kb
  }).catch(() => {});
  await ctx.answerCbQuery();
});

// UI: Batch Size
bot.action('admin_ui_batch', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('5 Posts', 'set_batch_5'), Markup.button.callback('10 Posts', 'set_batch_10')],
    [Markup.button.callback('15 Posts', 'set_batch_15'), Markup.button.callback('20 Posts', 'set_batch_20')],
    [Markup.button.callback('25 Posts', 'set_batch_25'), Markup.button.callback('30 Posts', 'set_batch_30')],
    [Markup.button.callback('🔙 Back', 'admin_refresh')]
  ]);
  await ctx.editMessageText('📦 <b>SELECT BATCH SIZE</b>\nChoose posts count per batch:', {
    parse_mode: 'HTML',
    ...kb
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action(/set_batch_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const size = Number(ctx.match[1]);
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { batch_size: size } }
  );
  await ctx.answerCbQuery(`Batch set to ${size}`);
  const cfg = await getConfig(db);
  await ctx.editMessageText(renderAdminText(cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});
});

// UI: Channel Auto-Approval
bot.action('admin_ui_channels', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);

  let text = `📢 <b>AUTO-APPROVE CHANNELS</b>\n\n`;
  (cfg.approved_channels || []).forEach((ch, idx) => {
    text += `${idx + 1}. <b>${ch.title}</b>\n`;
  });

  const buttons = [];
  (cfg.approved_channels || []).forEach((ch) => {
    buttons.push([Markup.button.callback(`🗑 Remove ${ch.title}`, `remove_ch_${ch.id}`)]);
  });
  buttons.push([Markup.button.callback('🔙 Back', 'admin_refresh')]);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action(/remove_ch_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const chId = Number(ctx.match[1]);
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $pull: { approved_channels: { id: chId } } }
  );
  await ctx.answerCbQuery('Removed');
  const cfg = await getConfig(db);

  let text = `📢 <b>AUTO-APPROVE CHANNELS</b>\n\n`;
  (cfg.approved_channels || []).forEach((ch, idx) => {
    text += `${idx + 1}. <b>${ch.title}</b>\n`;
  });

  const buttons = [];
  (cfg.approved_channels || []).forEach((ch) => {
    buttons.push([Markup.button.callback(`🗑 Remove ${ch.title}`, `remove_ch_${ch.id}`)]);
  });
  buttons.push([Markup.button.callback('🔙 Back', 'admin_refresh')]);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
});

// --- Serverless Gateway ---
module.exports = async (req, res) => {
  try {
    const db = await getDb();

    if (req.method === 'GET') {
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
        await runPostingBatch(db, false);
      }
      return res.status(200).json({ ok: true, keepalive: true });
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
