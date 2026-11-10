const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

// --- Direct Configurations & Fallbacks ---
const BOT_TOKEN = process.env.BOT_TOKEN || '9251791914:AAHG26G5mVVShsQpF8PK1fvpWgmZ__FNPCk';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oprashmikayasiru_db_user:AMcK5sVpxXr3R7VT@cluster0.ulukf3s.mongodb.net/?retryWrites=true&w=majority';
const VERCEL_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL.replace(/^https?:\/\//, '')}` : null;
const ADMIN_ID = Number(process.env.ADMIN_ID) || 5411921025;

// Channels Mapping
const SOURCE_CHANNEL_ID = Number(process.env.MAIN_CHANNEL_ID) || -1004309315754; // Hot Lanka V2
const TARGET_CHANNEL_ID = Number(process.env.TARGET_CHANNEL_ID) || -1004472514921; // VibeLK 🔥

const bot = new Telegraf(BOT_TOKEN);

// --- MongoDB Global Caching (Cold Start Prevention) ---
let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  cachedDb = client.db('vibelk_tools_db');
  return cachedDb;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- System State Helper ---
async function getConfig(db) {
  let cfg = await db.collection('settings').findOne({ _id: 'main_config' });
  if (!cfg) {
    cfg = {
      _id: 'main_config',
      is_active: true,
      batch_size: 10,
      schedule_times: ['05:00', '20:00'], // Morning 5:00 AM & Night 8:00 PM
      last_message_id: 1,
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

// --- Background Job: Post Batch Worker ---
async function runPostingBatch(db, manualTrigger = false) {
  const cfg = await getConfig(db);
  if (!cfg.is_active && !manualTrigger) return;

  // Duplicate Post Protector 1: Concurrency Lock
  const lockAcquired = await db.collection('settings').updateOne(
    { _id: 'main_config', is_posting_locked: { $ne: true } },
    { $set: { is_posting_locked: true } }
  );

  if (lockAcquired.matchedCount === 0) return;

  let currentMsgId = cfg.last_message_id || 1;
  let postedCount = 0;
  const targetCount = cfg.batch_size || 10;
  let consecutiveErrors = 0;
  const maxScanLimit = currentMsgId + 250;

  try {
    while (postedCount < targetCount && currentMsgId < maxScanLimit) {
      // Duplicate Post Protector 2: History Check
      const isAlreadyProcessed = await db.collection('processed_posts').findOne({ _id: currentMsgId });
      if (isAlreadyProcessed) {
        currentMsgId++;
        continue;
      }

      try {
        // Step 1: Copy message preserving original media & inline buttons
        const copied = await bot.telegram.copyMessage(
          TARGET_CHANNEL_ID,
          SOURCE_CHANNEL_ID,
          currentMsgId
        );

        // Step 2: Re-brand caption (Hot Lanka -> VibeLK)
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

        // Duplicate Post Protector 3: Instant Record & Pointer Advance
        await db.collection('processed_posts').insertOne({
          _id: currentMsgId,
          target_msg_id: copied.message_id,
          posted_at: new Date()
        });

        postedCount++;
        consecutiveErrors = 0;

        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          { $set: { last_message_id: currentMsgId + 1 } }
        );

        // Anti-flood Delay
        await sleep(2000);
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors > 60) break;
      }
      currentMsgId++;
    }

    if (postedCount > 0 && ADMIN_ID) {
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `✅ <b>Batch Completed:</b> ${postedCount} posts published to VibeLK! 🔥\n📌 Next Message ID: #${currentMsgId}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } finally {
    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { $set: { is_posting_locked: false } }
    );
  }
}

// --- Universal Auto-Approval Listener ---
bot.on('chat_join_request', async (ctx) => {
  try {
    const db = await getDb();
    const cfg = await getConfig(db);
    const incomingChatId = ctx.chatJoinRequest.chat.id;

    const isApprovedChannel = (cfg.approved_channels || []).some(
      (c) => String(c.id) === String(incomingChatId)
    );

    if (isApprovedChannel) {
      await ctx.telegram.approveChatJoinRequest(
        incomingChatId,
        ctx.chatJoinRequest.from.id
      );
    }
  } catch (e) {
    console.error('Auto-approval error:', e.message);
  }
});

// --- Admin Dashboard UI ---
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
    `📢 <b>Auto-Approve:</b> ${channelsCount} Channels`;
}

// --- Admin Handlers ---
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.replyWithHTML(renderAdminText(cfg), getAdminKeyboard(cfg));
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

// Times UI
bot.action('admin_ui_times', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  const activeTimes = cfg.schedule_times || [];

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`🌅 Morning (05:00 AM) ${activeTimes.includes('05:00') ? '✅' : '▫️'}`, 'toggle_time_05:00')],
    [Markup.button.callback(`🌇 Evening (03:00 PM) ${activeTimes.includes('15:00') ? '✅' : '▫️'}`, 'toggle_time_15:00')],
    [Markup.button.callback(`🌙 Night (08:00 PM)   ${activeTimes.includes('20:00') ? '✅' : '▫️'}`, 'toggle_time_20:00')],
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

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`🌅 Morning (05:00 AM) ${times.includes('05:00') ? '✅' : '▫️'}`, 'toggle_time_05:00')],
    [Markup.button.callback(`🌇 Evening (03:00 PM) ${times.includes('15:00') ? '✅' : '▫️'}`, 'toggle_time_15:00')],
    [Markup.button.callback(`🌙 Night (08:00 PM)   ${times.includes('20:00') ? '✅' : '▫️'}`, 'toggle_time_20:00')],
    [Markup.button.callback('🔙 Back', 'admin_refresh')]
  ]);

  await ctx.editMessageText('⏰ <b>SELECT POSTING TIMES</b>\nTap to toggle ON/OFF:', {
    parse_mode: 'HTML',
    ...kb
  }).catch(() => {});
  await ctx.answerCbQuery();
});

// Batch Size UI
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

// Channels Management UI
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
  buttons.push([Markup.button.callback('➕ Add Channel', 'admin_ui_add_ch')]);
  buttons.push([Markup.button.callback('🔙 Back', 'admin_refresh')]);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('admin_ui_add_ch', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.reply('Tap below to select a Channel you manage:', {
    reply_markup: {
      keyboard: [
        [
          {
            text: '📢 Select Channel',
            request_chat: {
              request_id: 1,
              chat_is_channel: true,
              bot_is_member: true
            }
          }
        ],
        [{ text: '❌ Cancel' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
  await ctx.answerCbQuery();
});

bot.on('chat_shared', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const sharedChat = ctx.message.chat_shared;
  if (!sharedChat) return;

  try {
    const chatInfo = await bot.telegram.getChat(sharedChat.chat_id);
    const db = await getDb();

    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      {
        $addToSet: {
          approved_channels: {
            id: chatInfo.id,
            title: chatInfo.title || 'Untitled Channel'
          }
        }
      }
    );

    await ctx.reply(`✅ <b>${chatInfo.title}</b> added to Auto-Approval!`, {
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true }
    });
  } catch (err) {
    await ctx.reply('❌ Could not add channel. Ensure Bot is an Administrator in that channel.', {
      reply_markup: { remove_keyboard: true }
    });
  }
});

bot.hears('❌ Cancel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply('Cancelled.', { reply_markup: { remove_keyboard: true } });
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
  buttons.push([Markup.button.callback('➕ Add Channel', 'admin_ui_add_ch')]);
  buttons.push([Markup.button.callback('🔙 Back', 'admin_refresh')]);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
});

// --- Serverless Entry Point ---
module.exports = async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const db = await getDb();

    // Cron Ping Handler
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
        runPostingBatch(db, false);
      }
      return;
    }

    // Process Incoming Telegram Updates
    if (req.method === 'POST' && req.body) {
      await bot.handleUpdate(req.body);
    }
  } catch (err) {
    console.error('Execution error:', err.message);
  }
};
