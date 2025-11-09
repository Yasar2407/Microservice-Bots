require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const { VERIFY_TOKEN, ACCESS_TOKEN, PHONE_NUMBER_ID } = process.env;

// ✅ Track processed messages (with user + timestamp)
const processedMessages = new Map();
const userSessions = {};
const sessionTimeouts = {};

// ✅ Microservice configuration
// const MICROSERVICES = {
//   bath: { port: 7001 },
//   livspace: { port: 7002 },
//   ai: { port: 7003 },
//   "proposal-estimator": { port: 7004 },
//   "abyat-imagine": { port: 7005 },
// };

const MICROSERVICES = {
  bath: { url: "https://bath-measure-k2lk.onrender.com/webhook" },
  livspace: { url: "https://livspace-k2lk.onrender.com/webhook" },
  ai: { url: "https://ai-session-k2lk.onrender.com/webhook" },
  "proposal-estimator": { url: "https://proposal-estimator-k2lk.onrender.com/webhook" },
  "abyat-imagine": { url: "https://abyat-imagine-k2lk.onrender.com/webhook" },
};


// 🕒 Auto-prune processed messages to prevent memory leaks
const CLEAN_INTERVAL_MS = 30 * 60 * 1000;
const ENTRY_TTL_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [id, meta] of processedMessages.entries()) {
    if (meta.time < cutoff) processedMessages.delete(id);
  }
}, CLEAN_INTERVAL_MS);

// 🧠 Generate a reliable message ID
function getMessageId(rawMsg, from) {
  let id = rawMsg?.id || rawMsg?.message_id || rawMsg?.stanza_id;
  if (!id || typeof id !== "string" || id.trim() === "") {
    id = `${from || "unknown"}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    console.warn(`⚠️ Missing webhook message id — using fallback id=${id}`);
  }
  return id;
}

// 🕒 Reset inactivity timer per user
function resetSessionTimeout(userId) {
  if (sessionTimeouts[userId]) clearTimeout(sessionTimeouts[userId]);
  sessionTimeouts[userId] = setTimeout(async () => {
    console.log(`⏰ Session expired for ${userId}`);
    delete userSessions[userId];
    delete sessionTimeouts[userId];
    // await sendTextMessage(
    //   userId,
    //   "⏰ Your session has expired due to inactivity.\n\nType *1* anytime to return to the *main menu*."
    // );
  }, 2 * 60 * 1000);
}

// ✅ Verify webhook (for Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ✅ Main webhook handler
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // immediate ack

  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from =
      msg?.from ||
      req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id ||
      "unknown_user";
    const msgId = getMessageId(msg, from);

    // 🧱 Prevent duplicate processing
    if (processedMessages.has(msgId)) {
      console.log(`⚠️ Duplicate message ignored: ${msgId}`);
      return;
    }
    processedMessages.set(msgId, { user: from, time: Date.now() });

    const msgType = msg?.type;
    let text = msg?.text?.body?.trim()?.toLowerCase() || "";
    let interactiveId = null;

    // 🟢 Handle interactive replies
    if (msgType === "interactive") {
      if (msg?.interactive?.button_reply?.id)
        interactiveId = msg.interactive.button_reply.id;
      else if (msg?.interactive?.list_reply?.id)
        interactiveId = msg.interactive.list_reply.id;
    }
    if (interactiveId) text = interactiveId.toLowerCase();

    console.log(`📩 Message from ${from}:`, text);

    // 🟢 Reset inactivity timer
    resetSessionTimeout(from);

    // 🧾 Typing indicator ON
    await sendTypingIndicator(from, msgId, true);

    // 🟢 Step 1: "menu" or "1" resets session
    if (["menu", "1"].includes(text)) {
      for (const [id, meta] of processedMessages.entries()) {
        if (meta.user === from) processedMessages.delete(id);
      }
      delete userSessions[from];
      console.log(`🔁 Session reset for ${from}`);
      await sendTypingIndicator(from, msgId, false);
      await sendMenuButtons(from);
      return;
    }

    // 🟢 Step 2: if user has no session, select microservice
    if (!userSessions[from]) {
      let selected = null;
      if (text.includes("bath")) selected = "bath";
      else if (text.includes("liv") || text.includes("livspace")) selected = "livspace";
      else if (text.includes("ai")) selected = "ai";
      else if (text.includes("proposal")) selected = "proposal-estimator";
      else if (text.includes("abyat")) selected = "abyat-imagine";

      if (!selected) {
        await sendTypingIndicator(from, msgId, false);
        await sendTextMessage(from, "⚠️ Invalid option. Please choose from the buttons below 👇");
        await sendMenuButtons(from);
        return;
      }

      userSessions[from] = selected;
      console.log(`✅ ${from} selected ${selected}`);

      const targetService = MICROSERVICES[selected];
      console.log('TARGET:',targetService);
      
      try {
        // await axios.post(`http://localhost:${targetService.port}/webhook`, {
        await axios.post(targetService.url, {

          entry: [
            {
              changes: [
                {
                  value: {
                    messages: [
                      {
                        id: `${from}-${Date.now()}`,
                        from,
                        text: { body: "hi" },
                        type: "text",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });
      } catch (err) {
        console.error(`❌ Forward error to ${selected}:`, err.message);
        await sendTypingIndicator(from, msgId, false);
        await sendTextMessage(from, "⚠️ Service temporarily unavailable. Please try again later.");
      }
      await sendTypingIndicator(from, msgId, false);
      return;
    }

    // 🟢 Step 3: forward to active service
    const selectedService = userSessions[from];
    const targetService = MICROSERVICES[selectedService];

    if (!targetService) {
      await sendTypingIndicator(from, msgId, false);
      await sendTextMessage(from, "⚠️ Selected service unavailable. Type *menu* to restart.");
      delete userSessions[from];
      return;
    }

    console.log(`➡️ Forwarding message from ${from} → ${selectedService} (${targetService.port})`);

    try {
      // await axios.post(`http://localhost:${targetService.port}/webhook`, req.body);
      await axios.post(targetService.url, req.body);
    } catch (err) {
      console.error(`❌ Failed to forward message to ${selectedService}:`, err.message);
      await sendTextMessage(from, "⚠️ Service temporarily unavailable. Please try again later.");
    }
    await sendTypingIndicator(from, msgId, false);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// ✅ Typing indicator (guarded)
async function sendTypingIndicator(to, messageId, isTyping) {
  try {
    console.log(`💬 Typing indicator ${isTyping ? "on" : "off"} for ${to}`);

    await axios.post(
      `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read", // ✅ Required
        message_id: messageId, // ✅ Required from webhook
        typing_indicator: isTyping ? { type: "text" } : undefined, // typing off happens automatically when you send the message
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.warn("⚠️ Typing indicator error:", err.response?.data || err.message);
  }
}

// ✅ Text message sender
async function sendTextMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("⚠️ Text send failed:", err.response?.data || err.message);
  }
}

// ✅ Menu buttons sender
async function sendMenuButtons(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: "✨ Welcome to BuilderPluss!" },
          body: { text: "Please choose one of the following options 👇" },
          footer: { text: "Powered by BuilderPluss Design Suite" },
          action: {
            button: "Select an Option",
            sections: [
              {
                title: "Design Services",
                rows: [
                  { id: "bath", title: "🚿 Bathroom Designer" },
                  { id: "livspace", title: "🎨 Livspace" },
                  { id: "ai", title: "🤖 AI Room Designer" },
                  { id: "proposal-estimator", title: "📐 Proposal Generator" },
                  { id: "abyat-imagine", title: "🏠 Abyat Imagine" },
                ],
              },
            ],
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("⚠️ Failed to send menu buttons:", err.response?.data || err.message);
  }
}

// ✅ Endpoint for session expiry notification (from microservices)
app.post("/session-expired", async (req, res) => {
  const { user } = req.body;
  if (!user) return res.sendStatus(400);
  console.log(`⏰ Session expired for ${user} (via microservice)`);
  delete userSessions[user];
  await sendTextMessage(
    user,
    "⏰ Your session has expired.\nType *1* anytime to return to the *main menu*."
  );
  res.sendStatus(200);
});

// ✅ Basic root endpoint
app.get('/', (req, res)=>{
    res.send("Welcome to BuilderPluss WhatsApp Gateway!")
})

// ✅ Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`✅ Gateway running on port ${PORT}`));
