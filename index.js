// index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
} = require("discord.js");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v10");
const sqlite3 = require("sqlite3").verbose();
const chrono = require("chrono-node");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, "todos.db");
const CHECK_INTERVAL =
  parseInt(process.env.REMINDER_CHECK_INTERVAL_SEC || "60", 10) * 1000;
const REMINDER_BEFORE_MIN = parseInt(
  process.env.REMINDER_BEFORE_MIN || "60",
  10
);

if (!TOKEN || !CLIENT_ID) {
  console.error("Set DISCORD_TOKEN and CLIENT_ID in .env");
  process.exit(1);
}

/* ---------- DB setup ---------- */
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS lists (
    list_id TEXT PRIMARY KEY,
    owner_type TEXT,
    title TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS members (
    list_id TEXT,
    user_id TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id TEXT,
    content TEXT,
    done INTEGER DEFAULT 0,
    deadline DATETIME,
    reminded INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
});

/* ---------- sqlite promise wrappers ---------- */
function runAsync(sql, params = []) {
  return new Promise((res, rej) => {
    db.run(sql, params, function (err) {
      if (err) return rej(err);
      res(this);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((res, rej) => {
    db.get(sql, params, (err, row) => {
      if (err) return rej(err);
      res(row);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((res, rej) => {
    db.all(sql, params, (err, rows) => {
      if (err) return rej(err);
      res(rows);
    });
  });
}

/* ---------- helpers ---------- */
function pairIdFor(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
async function ensureListExists(listId, ownerType = "pair") {
  await runAsync(
    `INSERT OR IGNORE INTO lists(list_id, owner_type, title) VALUES(?, ?, ?)`,
    [listId, ownerType, "Todos"]
  );
}
async function addMember(listId, userId) {
  await runAsync(`INSERT INTO members(list_id, user_id) VALUES(?, ?)`, [
    listId,
    userId,
  ]);
}
async function addItem(listId, content, deadline = null) {
  const r = await runAsync(
    `INSERT INTO items(list_id, content, deadline) VALUES(?, ?, ?)`,
    [listId, content, deadline]
  );
  return r.lastID;
}
async function listItems(listId) {
  return await allAsync(
    `SELECT id, content, done, deadline, reminded FROM items WHERE list_id = ? ORDER BY id ASC`,
    [listId]
  );
}
async function findUserPairList(userId) {
  const r = await getAsync(
    `SELECT list_id FROM members WHERE user_id = ? AND list_id LIKE 'pair:%' LIMIT 1`,
    [userId]
  );
  return r ? r.list_id : null;
}
async function markDone(listId, itemId) {
  const r = await runAsync(
    `UPDATE items SET done = 1 WHERE list_id = ? AND id = ?`,
    [listId, itemId]
  );
  return r.changes > 0;
}
async function deleteItem(listId, itemId) {
  const r = await runAsync(`DELETE FROM items WHERE list_id = ? AND id = ?`, [
    listId,
    itemId,
  ]);
  return r.changes > 0;
}
async function markReminded(itemId) {
  await runAsync(`UPDATE items SET reminded = 1 WHERE id = ?`, [itemId]);
}
async function getDueItemsWindow(beforeISO, afterISO) {
  return await allAsync(
    `SELECT DISTINCT i.id, i.list_id, i.content, i.deadline, m.user_id as member_id
     FROM items i JOIN members m ON m.list_id = i.list_id
     WHERE i.done = 0 AND i.reminded = 0 AND i.deadline IS NOT NULL
       AND datetime(i.deadline) <= datetime(?) AND datetime(i.deadline) > datetime(?)`,
    [beforeISO, afterISO]
  );
}
async function getMembersOfList(listId) {
  const rows = await allAsync(`SELECT user_id FROM members WHERE list_id = ?`, [
    listId,
  ]);
  return rows.map((r) => r.user_id);
}

/* ---------- new helper functions for position <-> id translation ---------- */
// translate 1-based position -> real DB id (or null if out of range)
async function getItemIdByPosition(listId, position) {
  if (position <= 0) return null;
  const row = await getAsync(
    `SELECT id FROM items WHERE list_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?`,
    [listId, position - 1]
  );
  return row ? row.id : null;
}

// compute the 1-based position of an item id within a list (useful for replies/reminders)
async function getPositionOfItem(listId, itemId) {
  // ensure the item exists in that list
  const exists = await getAsync(
    `SELECT 1 FROM items WHERE list_id = ? AND id = ?`,
    [listId, itemId]
  );
  if (!exists) return null;
  const row = await getAsync(
    `SELECT COUNT(*) as pos FROM items WHERE list_id = ? AND id <= ?`,
    [listId, itemId]
  );
  return row ? row.pos : null;
}

/* ---------- define global slash commands ---------- */
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add a todo (required: task, duration).")
    .addStringOption((opt) =>
      opt.setName("task").setDescription("Todo task text").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("duration")
        .setDescription("When it is due ")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("personal or shared")
        .addChoices(
          { name: "shared", value: "shared" },
          { name: "personal", value: "personal" }
        )
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("share")
    .setDescription("Create a shared list with another user (numeric user id).")
    .addStringOption((opt) =>
      opt
        .setName("other_id")
        .setDescription("Their numeric Discord user id")
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("List todos (personal or shared).")
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("personal or shared")
        .addChoices(
          { name: "shared", value: "shared" },
          { name: "personal", value: "personal" }
        )
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("done")
    .setDescription(
      "Mark an item done (use list position from /list, 1-based)."
    )
    .addIntegerOption((opt) =>
      opt
        .setName("id")
        .setDescription("List position (1-based)")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("personal or shared")
        .addChoices(
          { name: "shared", value: "shared" },
          { name: "personal", value: "personal" }
        )
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Delete a todo item by list position (1-based).")
    .addIntegerOption((opt) =>
      opt
        .setName("id")
        .setDescription("List position (1-based)")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("personal or shared")
        .addChoices(
          { name: "shared", value: "shared" },
          { name: "personal", value: "personal" }
        )
        .setRequired(false)
    )
    .toJSON(),
];

/* ---------- register GLOBAL commands (and optionally a test guild) ---------- */
(async () => {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log(
      "Commands to register:",
      commands.map((c) => c.name)
    );
    console.log("Registering GLOBAL application commands (overwrite)...");
    const registered = await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commands,
    });
    console.log("Registered global commands count:", registered.length);
    console.log("Registered names:", registered.map((c) => c.name).join(", "));

    // Optional: register to a test guild for instant propagation
    const TEST_GUILD_ID = process.env.TEST_GUILD_ID;
    if (TEST_GUILD_ID) {
      const guildRegistered = await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, TEST_GUILD_ID),
        { body: commands }
      );
      console.log(
        "Registered to test guild. Names:",
        guildRegistered.map((c) => c.name).join(", ")
      );
    } else {
      console.log(
        "No TEST_GUILD_ID set — skipping guild registration (global commands may take time to appear)."
      );
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

/* ---------- create client ---------- */
const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  startReminderLoop();
});

/* ---------- interaction handler ---------- */
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const userId = interaction.user.id;

    // /share
    if (interaction.commandName === "share") {
      const other = interaction.options.getString("other_id", true);
      if (other === userId)
        return interaction.reply({
          content: "You can't share with yourself.",
          ephemeral: false,
        });
      const pid = pairIdFor(userId, other);
      const listId = `pair:${pid}`;
      await ensureListExists(listId, "pair");
      await addMember(listId, userId);
      await addMember(listId, other);
      await interaction.reply({
        content: `Shared list created with user ID ${other}.`,
        ephemeral: false,
      });
      try {
        const usr = await client.users.fetch(other);
        await usr.send(
          `Hey — <@${userId}> created a shared todo list with you. Use /list shared to view it.`
        );
      } catch (e) {
        console.warn("Could not notify other user:", e.message);
      }
      return;
    }

    // /add
    if (interaction.commandName === "add") {
      await interaction.deferReply({ ephemeral: false });
      const task = interaction.options.getString("task", true);
      const duration = interaction.options.getString("duration", true);
      let scope = interaction.options.getString("scope") || "shared";

      const parsed = chrono.parseDate(duration, new Date(), {
        forwardDate: true,
      });
      if (!parsed) {
        return interaction.editReply({
          content:
            "Couldn't parse the duration. Try 'tomorrow 6pm' or '2025-12-10 14:00'.",
        });
      }
      const deadlineISO = parsed.toISOString();

      let listId;
      if (scope === "personal") {
        listId = `user:${userId}`;
        await ensureListExists(listId, "user");
        await addMember(listId, userId);
      } else {
        const found = await findUserPairList(userId);
        if (!found) {
          return interaction.editReply({
            content:
              "You don't have a shared list. Create one with `/share <other_user_id>`.",
          });
        }
        listId = found;
      }

      const itemId = await addItem(listId, task, deadlineISO);

      // compute position for the new item
      const posRow = await getAsync(
        `SELECT COUNT(*) as cnt FROM items WHERE list_id = ? AND id <= ?`,
        [listId, itemId]
      );
      const pos = posRow ? posRow.cnt : null;

      await interaction.editReply({
        content: `Added item **${pos}** — "${task}"\nDue: ${new Date(
          deadlineISO
        ).toLocaleString()}`,
      });

      // notify other members if pair
      if (listId.startsWith("pair:")) {
        const members = await getMembersOfList(listId);
        for (const m of members) {
          if (m !== userId) {
            try {
              const u = await client.users.fetch(m);
              await u.send(
                `⬜ New task added by <@${userId}>: **${task}** (no. ${pos}) — due ${new Date(
                  deadlineISO
                ).toLocaleString()}`
              );
            } catch (err) {
              console.warn("notify failed for", m, err.message);
            }
          }
        }
      }
      return;
    }

    // /list
    if (interaction.commandName === "list") {
      const scope = interaction.options.getString("scope") || "shared";
      let listId;
      if (scope === "personal") {
        listId = `user:${userId}`;
      } else {
        const found = await findUserPairList(userId);
        if (!found)
          return interaction.reply({
            content:
              "No shared list found. Create one with `/share <other_user_id>`.",
            ephemeral: false,
          });
        listId = found;
      }

      await ensureListExists(listId, scope === "personal" ? "user" : "pair");
      const rows = await listItems(listId);
      if (!rows || rows.length === 0)
        return interaction.reply({ content: "No items 📭", ephemeral: false });

      let out = `**geet or mere chote chote kaams (${scope=="shared"?"":scope})**\n`;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const pos = i + 1; // 1-based position
        const statusEmoji = r.done ? "✅" : "⬜";
        out += `${statusEmoji}  **${pos}:** ${r.content}`;
        if (r.deadline)
          out += ` — ⏰ *${new Date(r.deadline).toLocaleString()}*`;
        out += `\n`;
      }
      return interaction.reply({ content: out, ephemeral: false });
    }

    // /done
    if (interaction.commandName === "done") {
      const position = interaction.options.getInteger("id", true); // now treated as position
      const scope = interaction.options.getString("scope") || "shared";
      let listId;
      if (scope === "personal") {
        listId = `user:${userId}`;
      } else {
        const found = await findUserPairList(userId);
        if (!found)
          return interaction.reply({
            content: "No shared list found.",
            ephemeral: false,
          });
        listId = found;
      }

      const realId = await getItemIdByPosition(listId, position);
      if (!realId)
        return interaction.reply({
          content: `Could not find item number ${position} in your ${scope} list.`,
          ephemeral: false,
        });

      const ok = await markDone(listId, realId);
      if (!ok)
        return interaction.reply({
          content: "Could not mark done (maybe already removed).",
          ephemeral: false,
        });
      await interaction.reply({
        content: `✅ Marked item ${position} done`,
        ephemeral: false,
      });

      if (listId.startsWith("pair:")) {
        const members = await getMembersOfList(listId);
        for (const m of members) {
          if (m !== userId) {
            try {
              const u = await client.users.fetch(m);
              await u.send(
                `✅ <@${userId}> marked item number **${position}** as done.`
              );
            } catch (err) {
              /* ignore */
            }
          }
        }
      }
      return;
    }

    // /delete
    if (interaction.commandName === "delete") {
      const position = interaction.options.getInteger("id", true); // treated as position
      const scope = interaction.options.getString("scope") || "shared";
      let listId;
      if (scope === "personal") {
        listId = `user:${userId}`;
      } else {
        const found = await findUserPairList(userId);
        if (!found)
          return interaction.reply({
            content:
              "No shared list found. Create one with `/share <other_user_id>`.",
            ephemeral: false,
          });
        listId = found;
      }

      const realId = await getItemIdByPosition(listId, position);
      if (!realId) {
        return interaction.reply({
          content: `Could not delete item ${position}. Make sure the number is correct for your ${scope} list.`,
          ephemeral: false,
        });
      }

      const ok = await deleteItem(listId, realId);
      if (!ok) {
        return interaction.reply({
          content: `Could not delete item ${position}.`,
          ephemeral: false,
        });
      }

      await interaction.reply({
        content: `🗑️ Deleted item ${position} from your ${scope} list.`,
        ephemeral: false,
      });

      if (listId.startsWith("pair:")) {
        const members = await getMembersOfList(listId);
        for (const m of members) {
          if (m !== userId) {
            try {
              const u = await client.users.fetch(m);
              await u.send(
                `🗑️ <@${userId}> deleted item number **${position}** from the shared list.`
              );
            } catch (err) {
              console.warn("notify failed for", m, err.message);
            }
          }
        }
      }
      return;
    }
  } catch (err) {
    console.error("Interaction handler error", err);
    try {
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({ content: "An error occurred." });
      else
        await interaction.reply({
          content: "An error occurred.",
          ephemeral: false,
        });
    } catch {}
  }
});

/* ---------- Reminders (uses position when available) ---------- */
async function startReminderLoop() {
  setInterval(async () => {
    try {
      const now = new Date();
      const before = new Date(now.getTime() + REMINDER_BEFORE_MIN * 60 * 1000);
      const beforeISO = before.toISOString();
      const afterISO = now.toISOString();

      const rows = await getDueItemsWindow(beforeISO, afterISO);
      const itemsById = {};
      for (const r of rows) {
        if (!itemsById[r.id])
          itemsById[r.id] = {
            id: r.id,
            list_id: r.list_id,
            content: r.content,
            deadline: r.deadline,
            members: new Set(),
          };
        itemsById[r.id].members.add(r.member_id);
      }

      for (const k in itemsById) {
        const item = itemsById[k];
        const pos = await getPositionOfItem(item.list_id, item.id);
        const displayRef = pos ? `no. ${pos}` : `id ${item.id}`;
        const doneRef = pos ? `/done id:${pos}` : `/done id:${item.id}`;
        const membersList = Array.from(item.members);
        for (const m of membersList) {
          try {
            const u = await client.users.fetch(m);
            await u.send(
              `⏰ Reminder: Task "${
                item.content
              }" (${displayRef}) is due at ${new Date(
                item.deadline
              ).toLocaleString()}.\nkardiya to done karo jii: ${doneRef}`
            );
          } catch (err) {
            console.warn("reminder send failed", err.message);
          }
        }
        await markReminded(item.id);
      }
    } catch (err) {
      console.error("Reminder loop error", err);
    }
  }, CHECK_INTERVAL);
}

client.login(TOKEN);
