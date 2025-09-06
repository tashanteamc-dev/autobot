// bot.js - XFTEAM Telegram Bot (Polling + Keep Alive for Free Replit)
const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");
const https = require("https");

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const PASSWORD = "xfbest"; // password bot
const OWNER_ID = "YOUR_TELEGRAM_ID"; // ganti dengan Telegram ID kamu

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error("❌ BOT_TOKEN or DATABASE_URL missing!");
  process.exit(1);
}

// ---------- DB ----------
const db = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

db.connect()
  .then(async () => {
    console.log("✅ Database connected");
    await db.query(`
      CREATE TABLE IF NOT EXISTS channels (
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT,
        username TEXT,
        added_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (user_id, channel_id)
      );
    `);
  })
  .catch((err) => {
    console.error("❌ Database connection error", err);
    process.exit(1);
  });

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);
const userState = {}; // { userId: { step, content[] } }

let BOT_ID = null;
bot.telegram.getMe().then((me) => (BOT_ID = me.id));

// ---------- Helpers ----------
async function upsertChannel(userId, channelId) {
  const chat = await bot.telegram.getChat(channelId);
  const title = chat.title || channelId;
  const username = chat.username ? `@${chat.username}` : null;
  await db.query(
    `INSERT INTO channels (user_id, channel_id, title, username)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, channel_id)
      DO UPDATE SET title=EXCLUDED.title, username=EXCLUDED.username`,
    [String(userId), String(channelId), title, username]
  );
  return { channel_id: channelId, title, username };
}

async function listUserChannels(userId) {
  const res = await db.query(
    `SELECT channel_id, title, username FROM channels WHERE user_id=$1 ORDER BY title`,
    [String(userId)]
  );
  return res.rows;
}

async function broadcastContent(userId, content) {
  const channels = await listUserChannels(userId);
  if (!channels.length) return;

  const media = content.filter(item => item.type === "photo" || item.type === "video");
  const text = content.filter(item => item.type === "text");

  for (const ch of channels) {
    try {
      if (media.length > 1) {
        const mediaGroup = media.map(item => ({
          type: item.type,
          media: item.file_id,
          caption: item.caption,
        }));
        if (text.length > 0) {
          mediaGroup[0].caption = text[0].value;
          mediaGroup[0].parse_mode = "HTML";
        }
        await bot.telegram.sendMediaGroup(ch.channel_id, mediaGroup);
      } else {
        for (const item of content) {
          if (item.type === "text") {
            await bot.telegram.sendMessage(ch.channel_id, item.value, { parse_mode: "HTML" });
          } else if (item.type === "photo") {
            await bot.telegram.sendPhoto(ch.channel_id, item.file_id, { caption: item.caption || "" });
          } else if (item.type === "video") {
            await bot.telegram.sendVideo(ch.channel_id, item.file_id, { caption: item.caption || "" });
          } else if (item.type === "animation") {
            await bot.telegram.sendAnimation(ch.channel_id, item.file_id);
          } else if (item.type === "sticker") {
            await bot.telegram.sendSticker(ch.channel_id, item.file_id);
          }
        }
      }
    } catch (e) {
      console.error("❌ Broadcast error:", e.message);
      if (e.message && e.message.toLowerCase().includes("chat not found")) {
        await db.query("DELETE FROM channels WHERE user_id=$1 AND channel_id=$2", [userId, ch.channel_id]);
      }
    }
  }
}

// ---------- Express keep-alive ----------
const app = express();
app.get("/", (_, res) => res.send("Bot is running with polling ✅"));

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// ---------- Bot Commands ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;

  userState[ctx.from.id] = { step: "awaiting_password", content: [] };

  await ctx.reply("Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM\n");
  await ctx.reply("Please enter the password to use this bot:");
});

bot.on("my_chat_member", async (ctx) => {
  try {
    const { chat, from, new_chat_member } = ctx.update.my_chat_member;
    if (chat.type !== "channel") return;

    if (new_chat_member.status === "administrator") {
      const saved = await upsertChannel(from.id, chat.id);
      try {
        await bot.telegram.sendMessage(
          from.id,
          `✅ Channel linked: ${saved.title} ${saved.username || `(${saved.channel_id})`}`
        );
      } catch {}
    } else if (["left", "kicked"].includes(new_chat_member.status)) {
      await db.query("DELETE FROM channels WHERE channel_id=$1", [chat.id]);
    }
  } catch (e) {
    console.error("❌ Channel link error:", e.message);
  }
});

bot.hears("📋 View My Channels", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const channels = await listUserChannels(ctx.from.id);
  if (!channels.length) return ctx.reply("You have not linked any channels yet.");
  let text = "📌 Your Channels:\n";
  for (const ch of channels) text += `• ${ch.title} ${ch.username || `(${ch.channel_id})`}\n`;
  return ctx.reply(text);
});

bot.command("cancel", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["/start"], ["📋 View My Channels"], ["❌ Cancel Send"]]).resize());
});
bot.hears("❌ Cancel Send", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["/start"], ["📋 View My Channels"], ["❌ Cancel Send"]]).resize());
});

bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const msg = ctx.message;
  if (!msg || !msg.text && !msg.photo && !msg.video && !msg.animation && !msg.sticker) return;

  const state = userState[ctx.from.id];
  if (!state) return;

  if (state.step === "awaiting_password") {
    if (msg.text === PASSWORD) {
      state.step = "menu";
      await ctx.reply(
        "✅ Password correct! You can now use the bot.",
        Markup.keyboard([["/start"], ["📋 View My Channels"], ["❌ Cancel Send"]]).resize()
      );
    } else {
      await ctx.reply("❌ Wrong password! Please contact @kasiatashan");
    }
    return;
  }

  if (state.step === "menu") {
    let item = null;
    if (msg.text) {
      item = { type: "text", value: msg.text };
    } else if (msg.photo) {
      item = { type: "photo", file_id: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || "" };
    } else if (msg.video) {
      item = { type: "video", file_id: msg.video.file_id, caption: msg.caption || "" };
    } else if (msg.animation) {
      item = { type: "animation", file_id: msg.animation.file_id };
    } else if (msg.sticker) {
      item = { type: "sticker", file_id: msg.sticker.file_id };
    }

    if (item) {
      state.content.push(item);
      await ctx.reply("✅ Content received. Sending to all your channels...");
      await broadcastContent(ctx.from.id, state.content);
      state.content = [];
      await ctx.reply("✅ Done! Post sent to all your channels.");
    }
  }
});

// ---------- Launch Bot with Polling ----------
bot.launch()
  .then(() => {
    console.log("🤖 Bot launched with polling");
    if (OWNER_ID) bot.telegram.sendMessage(OWNER_ID, "✅ Bot is now online and running 24/7!");
  })
  .catch(err => console.error("❌ Launch error:", err));

// ---------- Self Ping ----------
setInterval(() => {
  https.get(`https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
}, 60000); // ping every 1 minute
