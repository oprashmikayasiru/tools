const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

// --- Configuration & IDs ---
const BOT_TOKEN = process.env.BOT_TOKEN || '9251791914:AAHG26G5mVVShsQpF8PK1fvpWgmZ__FNPCk';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://oprashmikayasiru_db_user:AMcK5sVpxXr3R7VT@cluster0.ulukf3s.mongodb.net/vibelk_tools_db?retryWrites=true&w=majority';
const ADMIN_ID = Number(process.env.ADMIN_ID) || 5411921025;

const SOURCE_CHANNEL_ID = -1004309315754; // Hot Lanka V2
const TARGET_CHANNEL_ID = -1004472514921; // VibeLK 🔥

const bot = new Telegraf(BOT_TOKEN);

// Register commands so they appear in Telegram menu only for Admin
let commandsRegistered = false;
async function setupAdminCommands() {
  if (commandsRegistered) return;
  try {
    await bot.telegram.setMyCommands(
      [
        { command: 'admin', description: 'Open Control Dashboard' },
        { command: 'resetdb', description: 'Reset Database History & ID' },
        { command: 'setid', description: 'Set Custom Message ID' },
        { command: 'cancel', description: 'Cancel Current Action' }
      ],
      { scope: { type: 'chat', chat_id: ADMIN_ID } }
    );
    commandsRegistered = true;
  } catch (err) {}
}

// --- Mongo Global Cache ---
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
      last_posted_hour: null,
      admin_state: null,
      approved_channels: [
        { id: SOURCE_CHANNEL_ID, title: 'Hot Lanka V2' },
        { id: TARGET_CHANNEL_ID, title: 'VibeLK 🔥' }
      ]
    };
    await db.collection('settings').insertOne(cfg);
  }
  return cfg;
}

// --- Bridge Processor: Forward -> Extract -> Delete Temp -> Dynamic Quote Post ---
async function copyWithExtractedButtons(msgId) {
  const forwarded = await bot.telegram.forwardMessage(
    ADMIN_ID,
    SOURCE_CHANNEL_ID,
    msgId,
    { disable_notification: true }
  );

  let targetMsg = null;

  try {
    const originalMarkup = forwarded.reply_markup || undefined;

    const entities = forwarded.caption_entities || forwarded.entities || [];
    const hasQuote = entities.some(
      (e) => e.type === 'blockquote' || e.type === 'expandable_blockquote'
    );

    let rawCaption = forwarded.caption || forwarded.text || '';
    let finalCaption = '';

    if (rawCaption) {
      rawCaption = rawCaption.replace(/Hot Lanka/gi, 'VibeLK');
      if (hasQuote) {
        finalCaption = `<blockquote>${rawCaption}</blockquote>`;
      } else {
        finalCaption = rawCaption;
      }
    }

    const postOptions = {
      caption: finalCaption,
      parse_mode: 'HTML',
      reply_markup: originalMarkup
    };

    if (forwarded.photo && forwarded.photo.length > 0) {
      const highestPhoto = forwarded.photo[forwarded.photo.length - 1].file_id;
      targetMsg = await bot.telegram.sendPhoto(TARGET_CHANNEL_ID, highestPhoto, postOptions);
    } else if (forwarded.video) {
      targetMsg = await bot.telegram.sendVideo(TARGET_CHANNEL_ID, forwarded.video.file_id, postOptions);
    } else if (forwarded.document) {
      targetMsg = await bot.telegram.sendDocument(TARGET_CHANNEL_ID, forwarded.document.file_id, postOptions);
    } else if (forwarded.animation) {
      targetMsg = await bot.telegram.sendAnimation(TARGET_CHANNEL_ID, forwarded.animation.file_id, postOptions);
    } else if (forwarded.text) {
      targetMsg = await bot.telegram.sendMessage(TARGET_CHANNEL_ID, finalCaption, {
        parse_mode: 'HTML',
        reply_markup: originalMarkup
      });
    } else {
      targetMsg = await bot.telegram.copyMessage(TARGET_CHANNEL_ID, SOURCE_CHANNEL_ID, msgId, {
        caption: finalCaption,
        parse_mode: 'HTML',
        reply_markup: originalMarkup
      });
    }
  } finally {
    await bot.telegram.deleteMessage(ADMIN_ID, forwarded.message_id).catch(() => {});
  }

  return targetMsg;
}

// --- Posting Batch Loop ---
async function runPostingBatch(db, manualTrigger = false) {
  const cfg = await getConfig(db);
  if (!cfg.is_active && !manualTrigger) return { posted: 0 };

  let currentMsgId = cfg.last_message_id || 7;
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

      await sleep(600);
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors > 25) break;
    }
    currentMsgId++;
  }

  return { posted: postedCount, nextId: currentMsgId };
}

// --- Auto-Approval Handler ---
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

// --- Simple English Admin Keyboard Helpers ---
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
  return `⚙️ <b>CONTROL PANEL</b>\n\n` +
    `📊 <b>Status:</b> ${cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
    `📦 <b>Batch:</b> ${cfg.batch_size} Posts\n` +
    `⏰ <b>Schedule:</b> ${timesStr}\n` +
    `📢 <b>Auto-Approve:</b> ${channelsCount} Channels\n` +
    `📌 <b>Current Post ID:</b> #${cfg.last_message_id || 7}`;
}

function getTimesKeyboard(times) {
  const buttons = [];
  (times || []).sort().forEach((t) => {
    buttons.push([
      Markup.button.callback(`🕒 ${t}`, 'noop'),
      Markup.button.callback(`❌ Remove`, `del_time_${t}`)
    ]);
  });

  buttons.push([Markup.button.callback('➕ Add Custom Time', 'admin_ui_add_time')]);
  buttons.push([Markup.button.callback('🔙 Back to Menu', 'admin_refresh')]);

  return Markup.inlineKeyboard(buttons);
}

// --- Commands (Strictly Admin Only) ---
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await setupAdminCommands();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.replyWithHTML(renderAdminText(cfg), getAdminKeyboard(cfg));
});

bot.command('resetdb', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('processed_posts').deleteMany({});
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { last_message_id: 7, is_posting_locked: false, admin_state: null } }
  );
  await ctx.reply('🗑️ <b>Database Reset Complete!</b>\nAll processed history cleared.\nNext Post ID reset to #7.', { parse_mode: 'HTML' });
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
  await ctx.reply(`✅ Next Post ID set to #${newId}`);
});

bot.command('cancel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: null } }
  );
  await ctx.reply('❌ Action cancelled.');
});

// --- UI Actions (Simple English) ---
bot.action('noop', (ctx) => ctx.answerCbQuery());

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
  await ctx.answerCbQuery('🚀 Posting batch in progress...');
  const db = await getDb();
  
  const result = await runPostingBatch(db, true);
  const cfg = await getConfig(db);

  await ctx.editMessageText(renderAdminText(cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});

  if (result.posted > 0) {
    await ctx.reply(`✅ <b>Success!</b> ${result.posted} posts published to VibeLK!\n📌 Next Post ID: #${result.nextId}`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(`⚠️ No new posts were found starting from ID #${cfg.last_message_id}.`);
  }
});

// Times Menu
bot.action('admin_ui_times', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);

  await ctx.editMessageText(
    '⏰ <b>SCHEDULE TIMES</b>\n\nManage your auto-posting times below:\n(Use 24-hour format, e.g., <code>09:30</code>, <code>20:00</code>)',
    {
      parse_mode: 'HTML',
      ...getTimesKeyboard(cfg.schedule_times)
    }
  ).catch(() => {});
  await ctx.answerCbQuery();
});

// Prompt Admin to send Time
bot.action('admin_ui_add_time', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_time' } }
  );

  await ctx.reply(
    '✍️ <b>Enter the posting time:</b>\n\n(Use 24-hour format: e.g. <code>08:30</code>, <code>14:15</code>, <code>21:00</code>)\n\n<i>Send /cancel to discard.</i>',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery();
});

// Remove Time
bot.action(/del_time_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const timeToRemove = ctx.match[1];
  const db = await getDb();
  
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $pull: { schedule_times: timeToRemove } }
  );

  const cfg = await getConfig(db);
  await ctx.editMessageText(
    '⏰ <b>SCHEDULE TIMES</b>\n\nManage your auto-posting times below:',
    {
      parse_mode: 'HTML',
      ...getTimesKeyboard(cfg.schedule_times)
    }
  ).catch(() => {});
  await ctx.answerCbQuery(`Removed ${timeToRemove}`);
});

// Add Time via Chat Text
bot.on('text', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const text = ctx.message.text.trim();
  const db = await getDb();
  const cfg = await getConfig(db);

  if (cfg.admin_state === 'waiting_for_time') {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(text)) {
      return ctx.reply('⚠️ <b>Invalid format!</b> Please use <code>HH:MM</code> format (e.g. <code>09:30</code>, <code>18:00</code>):', { parse_mode: 'HTML' });
    }

    const parts = text.split(':');
    const formattedTime = `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;

    await db.collection('settings').updateOne(
      { _id: 'main_config' },
      { 
        $addToSet: { schedule_times: formattedTime },
        $set: { admin_state: null }
      }
    );

    const updatedCfg = await getConfig(db);
    await ctx.reply(`✅ <b>${formattedTime}</b> added to schedule!`, {
      parse_mode: 'HTML',
      ...getTimesKeyboard(updatedCfg.schedule_times)
    });
  }
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
  await ctx.editMessageText('📦 <b>BATCH SIZE</b>\nChoose posts count per batch:', {
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

// UI: Auto-Approve Channels
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

    // Cron Ping Handler
    if (req.method === 'GET') {
      const now = new Date();
      const slDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const hours = String(slDate.getUTCHours()).padStart(2, '0');
      const minutes = slDate.getUTCMinutes();

      const cfg = await getConfig(db);

      if (cfg.is_active && (cfg.schedule_times || []).length > 0) {
        const matchedTime = cfg.schedule_times.find((t) => {
          const [tHour, tMin] = t.split(':').map(Number);
          return (
            Number(hours) === tHour &&
            Math.abs(minutes - tMin) < 5
          );
        });

        if (matchedTime && cfg.last_posted_hour !== matchedTime) {
          await db.collection('settings').updateOne(
            { _id: 'main_config' },
            { $set: { last_posted_hour: matchedTime } }
          );
          await runPostingBatch(db, false);
        }
      }

      return res.status(200).json({ ok: true, keepalive: true });
    }

    // Telegram Updates
    if (req.method === 'POST' && req.body) {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false });
  }
};
