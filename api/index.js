const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

// --- Configurations & Credentials (From Environment Variables) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = Number(process.env.ADMIN_ID) || 5411921025;

// Default Channel IDs
const DEFAULT_SOURCE_ID = -1004309315754; // Hot Lanka V2
const DEFAULT_TARGET_ID = -1004472514921; // VibeLK 🔥
const ARCHIVE_CHANNEL_ID = -1004429358184; // Private Archive DB

if (!BOT_TOKEN || !MONGODB_URI) {
  console.error('Missing BOT_TOKEN or MONGODB_URI in environment variables!');
}

const bot = new Telegraf(BOT_TOKEN);

// Register commands for Admin only in Telegram UI Menu
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
      connectTimeoutMS: 10000
    });
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  cachedDb = client.db('vibelk_tools_db');
  return cachedDb;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Configuration Initialization & Migration ---
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
      main_channel: { id: DEFAULT_SOURCE_ID, title: 'Hot Lanka V2' },
      target_channel: { id: DEFAULT_TARGET_ID, title: 'VibeLK 🔥' },
      archive_sync_enabled: true,
      archive_last_source_id: 7,
      archive_count: 0,
      restore_state: {
        is_restoring: false,
        target_id: null,
        target_title: null,
        current_archive_id: 1,
        last_restored_dest_id: 1
      },
      pending_restore: null,
      is_locked: false,
      lock_timestamp: 0,
      approved_channels: [
        { id: DEFAULT_SOURCE_ID, title: 'Hot Lanka V2' },
        { id: DEFAULT_TARGET_ID, title: 'VibeLK 🔥' }
      ]
    };
    await db.collection('settings').insertOne(cfg);
  } else {
    const updates = {};
    if (!cfg.main_channel) updates.main_channel = { id: DEFAULT_SOURCE_ID, title: 'Hot Lanka V2' };
    if (!cfg.target_channel) updates.target_channel = { id: DEFAULT_TARGET_ID, title: 'VibeLK 🔥' };
    if (cfg.archive_sync_enabled === undefined) updates.archive_sync_enabled = true;
    if (cfg.archive_last_source_id === undefined) updates.archive_last_source_id = cfg.last_message_id || 7;
    if (cfg.archive_count === undefined) updates.archive_count = 0;
    if (!cfg.restore_state) {
      updates.restore_state = {
        is_restoring: false,
        target_id: null,
        target_title: null,
        current_archive_id: 1,
        last_restored_dest_id: 1
      };
    }
    if (Object.keys(updates).length > 0) {
      await db.collection('settings').updateOne({ _id: 'main_config' }, { $set: updates });
      cfg = { ...cfg, ...updates };
    }
  }
  return cfg;
}

// --- Lock Helpers (Prevents Double Posting & Race Conditions) ---
async function acquireLock(db) {
  const cfg = await getConfig(db);
  const now = Date.now();
  if (cfg.is_locked && now - (cfg.lock_timestamp || 0) < 90000) {
    return false;
  }
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { is_locked: true, lock_timestamp: now } }
  );
  return true;
}

async function releaseLock(db) {
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { is_locked: false, lock_timestamp: 0 } }
  );
}

// --- Verify Bot Admin & Post Permission ---
async function verifyBotChannelAdmin(chatId) {
  try {
    const me = await bot.telegram.getMe();
    const member = await bot.telegram.getChatMember(chatId, me.id);
    if (member.status === 'administrator' || member.status === 'creator') {
      if (member.status === 'administrator' && member.can_post_messages === false) {
        return { ok: false, reason: 'Missing "Post Messages" permission.' };
      }
      return { ok: true };
    }
    return { ok: false, reason: 'Bot is not an Administrator in this channel.' };
  } catch (err) {
    return { ok: false, reason: 'Unable to access channel. Make sure Bot is added as Admin.' };
  }
}

// --- Entity-Based HTML Rebuilder (Preserves Bold, Quote, Italic, Links) ---
function rebuildHtmlWithEntities(text, entities) {
  if (!text) return '';
  if (!entities || entities.length === 0) return text;

  const tags = [];
  entities.forEach((e) => {
    let openTag = '';
    let closeTag = '';

    if (e.type === 'bold') {
      openTag = '<b>';
      closeTag = '</b>';
    } else if (e.type === 'italic') {
      openTag = '<i>';
      closeTag = '</i>';
    } else if (e.type === 'blockquote' || e.type === 'expandable_blockquote') {
      openTag = '<blockquote>';
      closeTag = '</blockquote>';
    } else if (e.type === 'code') {
      openTag = '<code>';
      closeTag = '</code>';
    } else if (e.type === 'text_link') {
      openTag = `<a href="${e.url}">`;
      closeTag = '</a>';
    }

    if (openTag && closeTag) {
      tags.push({ pos: e.offset, tag: openTag, isClose: false });
      tags.push({ pos: e.offset + e.length, tag: closeTag, isClose: true });
    }
  });

  tags.sort((a, b) => {
    if (a.pos !== b.pos) return b.pos - a.pos;
    if (a.isClose && !b.isClose) return -1;
    if (!a.isClose && b.isClose) return 1;
    return 0;
  });

  let result = text;
  for (const t of tags) {
    if (t.pos <= result.length) {
      result = result.slice(0, t.pos) + t.tag + result.slice(t.pos);
    }
  }

  return result;
}

// --- Bridge Processor: Source -> Extract -> Delete Temp -> Target/Archive ---
async function copyWithExtractedButtons(sourceId, targetId, msgId, options = {}) {
  const { rebrand = true, silent = false } = options;

  const forwarded = await bot.telegram.forwardMessage(
    ADMIN_ID,
    sourceId,
    msgId,
    { disable_notification: true }
  );

  let targetMsg = null;

  try {
    // Skip multi-photo/video albums only when posting to Rebrand Target
    if (rebrand && forwarded.media_group_id) {
      return { skippedAlbum: true };
    }

    const originalMarkup = forwarded.reply_markup || undefined;
    const rawText = forwarded.caption || forwarded.text || '';
    const entities = forwarded.caption_entities || forwarded.entities || [];

    let formattedText = rebuildHtmlWithEntities(rawText, entities);

    // Re-brand only for Target channel; keep 100% original for Archive & Restore
    if (rebrand) {
      formattedText = formattedText.replace(/Hot Lanka/gi, 'VibeLK');
    }

    const postOptions = {
      caption: formattedText,
      parse_mode: 'HTML',
      reply_markup: originalMarkup,
      disable_notification: silent
    };

    if (forwarded.photo && forwarded.photo.length > 0) {
      const highestPhoto = forwarded.photo[forwarded.photo.length - 1].file_id;
      targetMsg = await bot.telegram.sendPhoto(targetId, highestPhoto, postOptions);
    } else if (forwarded.video) {
      targetMsg = await bot.telegram.sendVideo(targetId, forwarded.video.file_id, postOptions);
    } else if (forwarded.document) {
      targetMsg = await bot.telegram.sendDocument(targetId, forwarded.document.file_id, postOptions);
    } else if (forwarded.animation) {
      targetMsg = await bot.telegram.sendAnimation(targetId, forwarded.animation.file_id, postOptions);
    } else if (forwarded.text) {
      targetMsg = await bot.telegram.sendMessage(targetId, formattedText, {
        parse_mode: 'HTML',
        reply_markup: originalMarkup,
        disable_notification: silent
      });
    } else {
      targetMsg = await bot.telegram.copyMessage(targetId, sourceId, msgId, {
        caption: formattedText,
        parse_mode: 'HTML',
        reply_markup: originalMarkup,
        disable_notification: silent
      });
    }
  } finally {
    await bot.telegram.deleteMessage(ADMIN_ID, forwarded.message_id).catch(() => {});
  }

  return targetMsg;
}

// --- Priority 1: Posting Batch Loop (Main -> Target Rebrand) ---
async function runPostingBatch(db, manualTrigger = false) {
  const locked = await acquireLock(db);
  if (!locked) return { posted: 0, busy: true };

  try {
    const cfg = await getConfig(db);
    if (!cfg.is_active && !manualTrigger) return { posted: 0 };

    const sourceId = cfg.main_channel.id;
    const targetId = cfg.target_channel.id;
    let currentMsgId = cfg.last_message_id || 7;
    let postedCount = 0;
    const targetCount = cfg.batch_size || 5;
    let consecutiveErrors = 0;
    const maxScanLimit = currentMsgId + 60;
    const startTime = Date.now();

    while (postedCount < targetCount && currentMsgId < maxScanLimit) {
      if (Date.now() - startTime > 7500) break;

      const isAlreadyProcessed = await db.collection('processed_posts').findOne({ _id: currentMsgId });
      if (isAlreadyProcessed) {
        currentMsgId++;
        continue;
      }

      try {
        const res = await copyWithExtractedButtons(sourceId, targetId, currentMsgId, {
          rebrand: true,
          silent: false
        });

        await db.collection('processed_posts').insertOne({
          _id: currentMsgId,
          posted_at: new Date(),
          skipped: Boolean(res && res.skippedAlbum)
        }).catch(() => {});

        if (!res || !res.skippedAlbum) {
          postedCount++;
        }
        consecutiveErrors = 0;

        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          { $set: { last_message_id: currentMsgId + 1 } }
        );

        await sleep(500);
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= 25) break;
      }
      currentMsgId++;
    }

    return { posted: postedCount, nextId: currentMsgId };
  } finally {
    await releaseLock(db);
  }
}

// --- Priority 2: Background Silent Archive Sync (Main -> Archive DB with Exact Buttons) ---
async function runArchiveSyncBatch(db, startTime) {
  const cfg = await getConfig(db);
  if (!cfg.archive_sync_enabled) return;

  const locked = await acquireLock(db);
  if (!locked) return;

  try {
    const sourceId = cfg.main_channel.id;
    let currentSrcId = cfg.archive_last_source_id || 7;
    let syncedInBatch = 0;
    let consecutiveErrors = 0;

    while (syncedInBatch < 4 && Date.now() - startTime < 6800) {
      try {
        const copied = await copyWithExtractedButtons(
          sourceId,
          ARCHIVE_CHANNEL_ID,
          currentSrcId,
          { rebrand: false, silent: true }
        );

        await db.collection('archive_map').insertOne({
          archive_msg_id: copied.message_id,
          source_msg_id: currentSrcId,
          synced_at: new Date()
        }).catch(() => {});

        syncedInBatch++;
        consecutiveErrors = 0;
        currentSrcId++;

        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          {
            $set: { archive_last_source_id: currentSrcId },
            $inc: { archive_count: 1 }
          }
        );

        await sleep(800);
      } catch (err) {
        const errMsg = String(err.message || '');
        if (errMsg.includes('429') || errMsg.includes('Too Many Requests')) {
          break;
        }
        consecutiveErrors++;
        currentSrcId++;
        if (consecutiveErrors >= 25) {
          await db.collection('settings').updateOne(
            { _id: 'main_config' },
            { $set: { archive_last_source_id: currentSrcId - consecutiveErrors } }
          );
          break;
        }
      }
    }
  } finally {
    await releaseLock(db);
  }
}

// --- Priority 2B: Disaster Recovery Restore Worker (Archive -> New Main with Auto-ID Sync) ---
async function runArchiveRestoreBatch(db, startTime) {
  const cfg = await getConfig(db);
  const rState = cfg.restore_state;
  if (!rState || !rState.is_restoring || !rState.target_id) return;

  const locked = await acquireLock(db);
  if (!locked) return;

  try {
    let archiveId = rState.current_archive_id || 1;
    let lastRestoredDestId = rState.last_restored_dest_id || 1;
    let restoredInBatch = 0;
    let consecutiveErrors = 0;

    while (restoredInBatch < 4 && Date.now() - startTime < 6800) {
      try {
        const sentMsg = await copyWithExtractedButtons(
          ARCHIVE_CHANNEL_ID,
          rState.target_id,
          archiveId,
          { rebrand: false, silent: true }
        );

        if (sentMsg && sentMsg.message_id) {
          lastRestoredDestId = sentMsg.message_id;
        }

        restoredInBatch++;
        consecutiveErrors = 0;
        archiveId++;

        await db.collection('settings').updateOne(
          { _id: 'main_config' },
          {
            $set: {
              'restore_state.current_archive_id': archiveId,
              'restore_state.last_restored_dest_id': lastRestoredDestId
            }
          }
        );

        await sleep(800);
      } catch (err) {
        const errMsg = String(err.message || '');
        if (errMsg.includes('429') || errMsg.includes('Too Many Requests')) {
          break;
        }
        consecutiveErrors++;
        archiveId++;

        if (consecutiveErrors >= 25) {
          const newMain = { id: rState.target_id, title: rState.target_title };
          const nextStartId = lastRestoredDestId + 1;

          await db.collection('processed_posts').deleteMany({});

          await db.collection('settings').updateOne(
            { _id: 'main_config' },
            {
              $set: {
                main_channel: newMain,
                last_message_id: nextStartId,
                archive_last_source_id: nextStartId,
                restore_state: {
                  is_restoring: false,
                  target_id: null,
                  target_title: null,
                  current_archive_id: 1,
                  last_restored_dest_id: 1
                }
              }
            }
          );

          await bot.telegram.sendMessage(
            ADMIN_ID,
            `✅ <b>Restore Complete!</b>\n` +
            `<b>${rState.target_title}</b> is now your Main Channel.\n` +
            `📌 Next Post ID set to: <b>#${nextStartId}</b> (No duplicate posts will be sent to Target).`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          break;
        }
      }
    }
  } finally {
    await releaseLock(db);
  }
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

// --- UI Renderers & Keyboards (Simple English) ---
function renderAdminText(cfg) {
  const timesStr = (cfg.schedule_times || []).join(', ') || 'None';
  const archiveState = cfg.archive_sync_enabled
    ? `🟢 Synced (${cfg.archive_count || 0} Posts)`
    : `🔴 OFF (${cfg.archive_count || 0} Posts)`;

  let restoreLine = '';
  if (cfg.restore_state && cfg.restore_state.is_restoring) {
    restoreLine = `\n♻️ <b>Restoring:</b> To ${cfg.restore_state.target_title} (#${cfg.restore_state.current_archive_id})`;
  }

  return (
    `⚙️ <b>CONTROL PANEL</b>\n\n` +
    `📊 <b>Status:</b> ${cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
    `📥 <b>Main:</b> ${cfg.main_channel.title}\n` +
    `📤 <b>Target:</b> ${cfg.target_channel.title}\n` +
    `🗄️ <b>Archive:</b> ${archiveState}\n` +
    `📦 <b>Batch:</b> ${cfg.batch_size} | ⏰ ${timesStr}\n` +
    `📌 <b>Next ID:</b> #${cfg.last_message_id || 7}` +
    restoreLine
  );
}

function getAdminKeyboard(cfg) {
  const statusIcon = cfg.is_active ? '🟢 ACTIVE' : '🔴 PAUSED';
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Post Now', 'admin_post_now')],
    [
      Markup.button.callback(`📦 Batch: ${cfg.batch_size}`, 'admin_ui_batch'),
      Markup.button.callback('⏰ Set Times', 'admin_ui_times')
    ],
    [
      Markup.button.callback('⚙️ Manage', 'admin_ui_manage'),
      Markup.button.callback('📢 Channels', 'admin_ui_channels')
    ],
    [
      Markup.button.callback(`Status: ${statusIcon}`, 'admin_toggle_status'),
      Markup.button.callback('🔄 Refresh', 'admin_refresh')
    ]
  ]);
}

function renderManageText(cfg) {
  return (
    `⚙️ <b>MANAGE CHANNELS & ARCHIVE</b>\n\n` +
    `📥 <b>Main:</b> ${cfg.main_channel.title}\n` +
    `📤 <b>Target:</b> ${cfg.target_channel.title}\n` +
    `🗄️ <b>Archive Sync:</b> ${cfg.archive_sync_enabled ? '🟢 ON (Silent)' : '🔴 OFF'}\n` +
    `💾 <b>Saved Posts:</b> ${cfg.archive_count || 0}`
  );
}

function getManageKeyboard(cfg) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📥 Select Main', 'pick_ch_main'),
      Markup.button.callback('📤 Select Target', 'pick_ch_target')
    ],
    [
      Markup.button.callback(
        `🗄️ Archive Sync: ${cfg.archive_sync_enabled ? '🟢 ON' : '🔴 OFF'}`,
        'toggle_archive_sync'
      )
    ],
    [Markup.button.callback('♻️ Restore Archive', 'pick_ch_restore')],
    [Markup.button.callback('🔙 Back', 'admin_refresh')]
  ]);
}

function getTimesKeyboard(times) {
  const buttons = [];
  (times || []).sort().forEach((t) => {
    buttons.push([
      Markup.button.callback(`🕒 ${t}`, 'noop'),
      Markup.button.callback('❌ Remove', `del_time_${t}`)
    ]);
  });

  buttons.push([Markup.button.callback('➕ Add Custom Time', 'admin_ui_add_time')]);
  buttons.push([Markup.button.callback('🔙 Back', 'admin_refresh')]);

  return Markup.inlineKeyboard(buttons);
}

// Trigger Telegram Native Channel Picker (request_chat)
async function promptNativeChannelPicker(ctx, requestId, promptTitle) {
  await ctx.reply(promptTitle, {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [
          {
            text: '📂 Open Channel List',
            request_chat: {
              request_id: requestId,
              chat_is_channel: true,
              request_title: true
            }
          }
        ]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

// --- Commands (Strictly Admin Only) ---
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await setupAdminCommands();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.replyWithHTML(renderAdminText(cfg), {
    ...getAdminKeyboard(cfg)
  });
});

bot.command('resetdb', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await setupAdminCommands();

  const confirmKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('⚠️ Yes, Reset', 'confirm_reset_db'),
      Markup.button.callback('❌ Cancel', 'cancel_reset_db')
    ]
  ]);

  await ctx.replyWithHTML(
    '⚠️ <b>CONFIRM DATABASE RESET</b>\n\nReset all post history and restart from ID #7?',
    confirmKeyboard
  );
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
    { $set: { admin_state: null, pending_restore: null } }
  );
  await ctx.reply('❌ Action cancelled.', {
    reply_markup: { remove_keyboard: true }
  });
});

// --- Native Channel Picker Result Handler (chat_shared) ---
bot.on('message', async (ctx, next) => {
  if (ctx.from && ctx.from.id === ADMIN_ID && ctx.message && ctx.message.chat_shared) {
    const shared = ctx.message.chat_shared;
    const reqId = shared.request_id;
    const chId = Number(shared.chat_id);
    const chTitle = shared.title || `Channel (${chId})`;
    const db = await getDb();

    const check = await verifyBotChannelAdmin(chId);
    if (!check.ok) {
      await ctx.reply(
        `⚠️ <b>Permission Error:</b> ${check.reason}\nPlease make me an Admin in <b>${chTitle}</b> and try again.`,
        {
          parse_mode: 'HTML',
          reply_markup: { remove_keyboard: true }
        }
      );
      return;
    }

    if (reqId === 1) {
      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $set: { main_channel: { id: chId, title: chTitle } } }
      );
      const cfg = await getConfig(db);
      await ctx.reply(`✅ Main Channel updated to: <b>${chTitle}</b>`, {
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
      });
      await ctx.replyWithHTML(renderManageText(cfg), getManageKeyboard(cfg));
      return;
    }

    if (reqId === 2) {
      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $set: { target_channel: { id: chId, title: chTitle } } }
      );
      const cfg = await getConfig(db);
      await ctx.reply(`✅ Target Channel updated to: <b>${chTitle}</b>`, {
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
      });
      await ctx.replyWithHTML(renderManageText(cfg), getManageKeyboard(cfg));
      return;
    }

    if (reqId === 3) {
      const cfg = await getConfig(db);
      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $set: { pending_restore: { id: chId, title: chTitle } } }
      );

      await ctx.reply('Channel selected:', {
        reply_markup: { remove_keyboard: true }
      });

      await ctx.replyWithHTML(
        `⚠️ <b>CONFIRM RESTORE</b>\n\n` +
        `Restore <b>${cfg.archive_count || 0}</b> archived posts to <b>${chTitle}</b>?\n` +
        `It will become your new Main Channel.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Yes, Restore', 'confirm_restore_archive'),
            Markup.button.callback('❌ Cancel', 'cancel_restore_archive')
          ]
        ])
      );
      return;
    }

    if (reqId === 4) {
      await db.collection('settings').updateOne(
        { _id: 'main_config' },
        { $addToSet: { approved_channels: { id: chId, title: chTitle } } }
      );
      await ctx.reply(`✅ Added <b>${chTitle}</b> to Auto-Approve list.`, {
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
      });
      const cfg = await getConfig(db);
      await ctx.replyWithHTML(renderAdminText(cfg), getAdminKeyboard(cfg));
      return;
    }
  }
  return next();
});

// --- Manage & Picker Actions ---
bot.action('admin_ui_manage', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  await ctx.editMessageText(renderManageText(cfg), {
    parse_mode: 'HTML',
    ...getManageKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('pick_ch_main', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await promptNativeChannelPicker(
    ctx,
    1,
    '📥 <b>SELECT MAIN CHANNEL</b>\n\nTap the button below to pick a channel from your list:'
  );
});

bot.action('pick_ch_target', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await promptNativeChannelPicker(
    ctx,
    2,
    '📤 <b>SELECT TARGET CHANNEL</b>\n\nTap the button below to pick a channel from your list:'
  );
});

bot.action('pick_ch_restore', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await promptNativeChannelPicker(
    ctx,
    3,
    '♻️ <b>RESTORE ARCHIVE</b>\n\nTap the button below to choose the destination channel:'
  );
});

bot.action('pick_ch_approve', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await promptNativeChannelPicker(
    ctx,
    4,
    '📢 <b>ADD AUTO-APPROVE CHANNEL</b>\n\nTap the button below to pick a channel:'
  );
});

bot.action('toggle_archive_sync', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);
  const nextState = !cfg.archive_sync_enabled;

  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { archive_sync_enabled: nextState } }
  );
  cfg.archive_sync_enabled = nextState;

  await ctx.editMessageText(renderManageText(cfg), {
    parse_mode: 'HTML',
    ...getManageKeyboard(cfg)
  }).catch(() => {});
  await ctx.answerCbQuery(`Archive Sync: ${nextState ? 'ON' : 'OFF'}`);
});

bot.action('confirm_restore_archive', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);

  if (!cfg.pending_restore) {
    return ctx.answerCbQuery('No pending restore found.');
  }

  const dest = cfg.pending_restore;
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    {
      $set: {
        restore_state: {
          is_restoring: true,
          target_id: dest.id,
          target_title: dest.title,
          current_archive_id: 1,
          last_restored_dest_id: 1
        },
        pending_restore: null
      }
    }
  );

  await ctx.editMessageText(
    `♻️ <b>Restore Started!</b>\nRestoring ${cfg.archive_count || 0} archived posts to <b>${dest.title}</b> in background...`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await ctx.answerCbQuery('Restore Started');
});

bot.action('cancel_restore_archive', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { pending_restore: null } }
  );
  await ctx.editMessageText('❌ <b>Restore Cancelled.</b>', { parse_mode: 'HTML' }).catch(() => {});
  await ctx.answerCbQuery('Cancelled');
});

// --- Database Reset Actions ---
bot.action('confirm_reset_db', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();

  await db.collection('processed_posts').deleteMany({});
  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { last_message_id: 7, is_locked: false, admin_state: null } }
  );

  await ctx.editMessageText(
    '🗑️ <b>Database Reset Complete!</b>\nNext Post ID reset to #7.',
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await ctx.answerCbQuery('Reset Complete');
});

bot.action('cancel_reset_db', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  await ctx.editMessageText('❌ <b>Reset Cancelled.</b>', { parse_mode: 'HTML' }).catch(() => {});
  await ctx.answerCbQuery('Cancelled');
});

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
  await ctx.answerCbQuery('🚀 Publishing batch...');
  const db = await getDb();

  const result = await runPostingBatch(db, true);
  const cfg = await getConfig(db);

  await ctx.editMessageText(renderAdminText(cfg), {
    parse_mode: 'HTML',
    ...getAdminKeyboard(cfg)
  }).catch(() => {});

  if (result.busy) {
    await ctx.reply('⏳ Another task is currently running. Please try again in a few seconds.');
  } else if (result.posted > 0) {
    await ctx.reply(
      `✅ Published <b>${result.posted}</b> posts to <b>${cfg.target_channel.title}</b>! (Next ID: #${result.nextId})`,
      { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply(`⚠️ No new posts found from ID #${cfg.last_message_id}.`);
  }
});

// --- Schedule Times Actions ---
bot.action('admin_ui_times', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);

  await ctx.editMessageText(
    '⏰ <b>SCHEDULE TIMES</b>\n\nManage auto-posting times (24-hour format):',
    {
      parse_mode: 'HTML',
      ...getTimesKeyboard(cfg.schedule_times)
    }
  ).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('admin_ui_add_time', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();

  await db.collection('settings').updateOne(
    { _id: 'main_config' },
    { $set: { admin_state: 'waiting_for_time' } }
  );

  await ctx.reply(
    '✍️ <b>Enter posting time:</b>\n(24-hour format: e.g. <code>08:30</code>, <code>20:00</code>)\n\n<i>Send /cancel to discard.</i>',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCbQuery();
});

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
    '⏰ <b>SCHEDULE TIMES</b>\n\nManage auto-posting times:',
    {
      parse_mode: 'HTML',
      ...getTimesKeyboard(cfg.schedule_times)
    }
  ).catch(() => {});
  await ctx.answerCbQuery(`Removed ${timeToRemove}`);
});

bot.on('text', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const text = ctx.message.text.trim();
  const db = await getDb();
  const cfg = await getConfig(db);

  if (cfg.admin_state === 'waiting_for_time') {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(text)) {
      return ctx.reply(
        '⚠️ <b>Invalid format!</b> Use <code>HH:MM</code> (e.g. <code>09:30</code>):',
        { parse_mode: 'HTML' }
      );
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

// --- Batch Size Actions ---
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

// --- Auto-Approve Channels Actions ---
bot.action('admin_ui_channels', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery();
  const db = await getDb();
  const cfg = await getConfig(db);

  let text = `📢 <b>AUTO-APPROVE CHANNELS</b>\n\n`;
  (cfg.approved_channels || []).forEach((ch, idx) => {
    text += `${idx + 1}. <b>${ch.title}</b>\n`;
  });

  const buttons = [[Markup.button.callback('➕ Add Channel', 'pick_ch_approve')]];
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

  const buttons = [[Markup.button.callback('➕ Add Channel', 'pick_ch_approve')]];
  (cfg.approved_channels || []).forEach((ch) => {
    buttons.push([Markup.button.callback(`🗑 Remove ${ch.title}`, `remove_ch_${ch.id}`)]);
  });
  buttons.push([Markup.button.callback('🔙 Back', 'admin_refresh')]);

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
});

// --- Serverless Gateway (Priority Scheduled Posting + Background Archive) ---
module.exports = async (req, res) => {
  const startTime = Date.now();

  try {
    const db = await getDb();

    if (req.method === 'GET') {
      const now = new Date();
      const slDate = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const hours = String(slDate.getUTCHours()).padStart(2, '0');
      const minutes = slDate.getUTCMinutes();

      const cfg = await getConfig(db);
      let ranScheduledPost = false;

      // PRIORITY 1: Check Scheduled Target Posting
      if (cfg.is_active && (cfg.schedule_times || []).length > 0) {
        const matchedTime = cfg.schedule_times.find((t) => {
          const [tHour, tMin] = t.split(':').map(Number);
          return Number(hours) === tHour && Math.abs(minutes - tMin) < 5;
        });

        if (matchedTime && cfg.last_posted_hour !== matchedTime) {
          await db.collection('settings').updateOne(
            { _id: 'main_config' },
            { $set: { last_posted_hour: matchedTime } }
          );
          await runPostingBatch(db, false);
          ranScheduledPost = true;
        }
      }

      // PRIORITY 2: Skip Archive/Restore during scheduled publish window
      if (!ranScheduledPost) {
        if (cfg.restore_state && cfg.restore_state.is_restoring) {
          await runArchiveRestoreBatch(db, startTime);
        } else if (cfg.archive_sync_enabled) {
          await runArchiveSyncBatch(db, startTime);
        }
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
