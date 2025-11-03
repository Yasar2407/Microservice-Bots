require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const mime = require("mime-types");

const app = express();
app.use(express.json());


// ✅ WhatsApp Webhook Handler
const processedMessages = new Set(); // Track processed message IDs
const userSessions = {}; // Store sessionId by phone number
const sessionTimeouts = {}; // Handle user inactivity timers

// 🕒 Session timeout logic
function resetSessionTimeout(userId) {
  if (sessionTimeouts[userId]) clearTimeout(sessionTimeouts[userId]);
  sessionTimeouts[userId] = setTimeout(async () => {
    console.log(`⏰ Session expired for ${userId}`);

    await sendTextMessage(userId,"⏰ Your session has expired due to inactivity.\n\nPlease send any message to start a new session 😊");
    
    delete userSessions[userId];
    delete sessionTimeouts[userId];
  }, 2 * 60 * 1000);
}

//Reuse Tokens from .env
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const AUTHORIZE_TOKEN = process.env.AUTHORIZE_TOKEN;

// ✅ Webhook Verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ✅ WhatsApp Webhook Handler
app.post("/webhook", async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = msg?.from;
  const msgId = msg?.id;

  if (!msg || !from) return res.sendStatus(200);

   // 🧩 Immediately acknowledge webhook to avoid retries
  res.sendStatus(200);

  // ⛔ Skip duplicate message IDs
  if (processedMessages.has(msgId)) {
    console.log(`⚠️ Duplicate message ignored: ${msgId}`);
    return;
  }

   processedMessages.add(msgId);
  console.log("📩 Received message:", msg);

  try {
    if (msg.type === "text") {
      const text = msg.text.body.trim().toLowerCase();
      await sessionResponseAPI(from, text, msgId);
    }

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    await sendFallbackMessage(from);
  }

});

async function sessionResponseAPI(to, query, msgId) {
  try {
    resetSessionTimeout(to);
     // 🟡 Start typing indicator
    await sendTypingIndicator(to, msgId, true);

    const formData = new FormData();
    formData.append("query", query);

    // ♻️ Reuse session if available
    const existingSessionId = userSessions[to];
    if (existingSessionId) {
      formData.append("sessionId", existingSessionId);
      console.log(`♻️ Using existing session for ${to}: ${existingSessionId}`);
    }

    // 🔹 Call AI agent
    const agentRes = await axios.post(
      "https://api.gettaskagent.com/api/user/agent/start/6901eb5627a015e1ec3608d6",
      formData,
      {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
          subdomain: "construex",
          "x-user-type": "customer",
        },
      }
    );

    // 🟢 Stop typing indicator
    await sendTypingIndicator(to, msgId, false);

    console.log("🤖 Agent API success:", agentRes.data);

    const aiResult = agentRes?.data?.workflowlog?.tasks?.find(
      (t) => t.tool === "gemini-chat-ai-(session)"
    )?.result?.data;

    console.log("AI Result:", aiResult);

    if (!aiResult?.response) {
      await sendTextMessage(to, "⚠️ No valid AI response received.");
      return;
    }

    // 🧩 Extract the structured response and query
    let responseText = aiResult.response;
    let userQuery = query;

    try {
      // Only parse if it looks like JSON content
      if (typeof responseText === "string") {
 const cleaned = responseText
      .replace(/^[\s\S]*?```json/i, "") // remove everything before ```json
      .replace(/```[\s\S]*$/i, "")      // remove everything after ```
      .trim();
      const parsed = JSON.parse(cleaned);

        if (parsed?.response) responseText = parsed.response;
        if (parsed?.query) userQuery = parsed.query;
      }
    } catch (err) {
      console.warn("⚠️ Failed to parse structured JSON, using raw response text.");
    }

    // 💾 Save session
    const sessionId = aiResult.session_id;
    if (sessionId && !userSessions[to]) {
      userSessions[to] = sessionId;
      console.log(`💾 Saved new session for ${to}: ${sessionId}`);
    }

    responseText = `${responseText}\n\n\n\nType *1* anytime - return to *main menu*.`;

    // 📨 Always send only the "response" part to WhatsApp
    await sendTextMessage(to, responseText);

    // 🚀 If the query was extracted from AI JSON, call next API
    if (userQuery && userQuery !== query) {
      console.log(`🚀 Forwarding extracted query to callAgentAPI: ${userQuery}`);
      await callAgentAPI(to, userQuery, msgId);
    }

  } catch (err) {
    await sendTypingIndicator(to, msgId, false);
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(
      to,
      "⚠️ Something went wrong while generating your design. Please try again later."
    );
  }
}

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


async function callAgentAPI(to, query, msgId) {
  try {
    // 🟡 Start typing indicator
    await sendTypingIndicator(to, msgId, true);

    const formData = new FormData();
    formData.append("query", query);

    const agentRes = await axios.post(
      "https://api.gettaskagent.com/api/user/agent/start/6900be6627a015e1ec35ebaa",
      formData,
      {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
          subdomain: "construex",
          "x-user-type": "customer",
        },
      }
    );

     // 🟢 Stop typing indicator
    await sendTypingIndicator(to, msgId, false);

    const aiResult = agentRes?.data?.workflowlog?.tasks?.find(
      (t) => t.tool === "generate-image(1)"
    )?.result?.data;

    if (!Array.isArray(aiResult) || aiResult.length === 0) {
  throw new Error("No AI result data found or invalid format.");
}

    for (const iteration of aiResult) {
  try {
    const imageUrl = iteration?.data?.s3_url;
    const promptText = iteration?.value?.prompt;

    if (!imageUrl) {
      console.warn(`⚠️ Skipping iteration ${iteration?.iteration}: No image URL found.`);
      continue;
    }

    console.log(`📤 Processing iteration ${iteration?.iteration}...`);
    console.log(`🖼️ Image URL: ${imageUrl}`);

    // 1️⃣ Upload image to WhatsApp to get a mediaId
    const mediaId = await uploadImageToWhatsApp(imageUrl);
    console.log(`✅ Uploaded image. Media ID: ${mediaId}`);

    // 2️⃣ Send interactive reply to WhatsApp user
    await sendInteractiveDesignReply(to, mediaId, promptText);
    console.log(`✅ Sent interactive design reply for iteration ${iteration?.iteration}`);

    // 3️⃣ Optional: Delay between sends (to avoid WhatsApp rate limits)
    await new Promise((res) => setTimeout(res, 2000));

  } catch (err) {
    console.error(`❌ Error processing iteration ${iteration?.iteration}:`, err.message);
  }
}
  } catch (err) {
    await sendTypingIndicator(to, msgId, false);
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(
      to,
      "⚠️ Something went wrong while generating your design. Please try again later."
    );
  }
}

// 🔹 Upload image to WhatsApp and return media ID
async function uploadImageToWhatsApp(imageUrl) {
  try {
    // 1️⃣ Download image from URL
    const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });

    // 2️⃣ Detect MIME type safely
    let mimeType = imageResponse.headers["content-type"];
    if (!mimeType || mimeType === "binary/octet-stream") {
      const guessedMime = mime.lookup(imageUrl);
      mimeType = guessedMime || "image/jpeg"; // fallback to jpeg
    }

    // 3️⃣ Get file extension for filename
    const fileExt = mime.extension(mimeType) || "jpg";

    console.log("🧾 Uploading image to WhatsApp with type:", mimeType);

    // 4️⃣ Prepare form data
    const formData = new FormData();
    formData.append("file", Buffer.from(imageResponse.data), {
      filename: `image.${fileExt}`,
      contentType: mimeType,
    });
    formData.append("type", mimeType);
    formData.append("messaging_product", "whatsapp");

    // 5️⃣ Upload to WhatsApp Graph API
    const uploadRes = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          ...formData.getHeaders(),
        },
      }
    );

    console.log("✅ WhatsApp upload success:", uploadRes.data);
    return uploadRes.data.id; // ✅ return WhatsApp media ID
  } catch (err) {
    console.error("❌ uploadImageToWhatsApp error:", err.response?.data || err.message);
    throw err;
  }
}

// 🔹 Send AI design reply (image + caption only)
async function sendInteractiveDesignReply(to, mediaId, promptText) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: {
          id: mediaId, // ✅ Already uploaded image to WhatsApp
          caption: `🖼️ *AI Design Preview*\n\nHere’s your personalized design idea from AI Home Designer 🧠✨`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Sent AI design image with caption successfully.");
  } catch (err) {
    console.error("❌ sendInteractiveDesignReply error:", err.response?.data || err.message);
    throw err;
  }
}


// 🔹 Reusable text message sender
async function sendTextMessage(to, message) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}


app.listen(process.env.PORT, () => {
  console.log(`✅ WhatsApp RAG bot running on port ${process.env.PORT}`);
}); 