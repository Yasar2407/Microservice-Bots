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

  // await sendTextMessage(userId,"⏰ Your session has expired due to inactivity.\n\nPlease send any message to start a new session 😊");

  delete userSessions[userId];
  delete sessionTimeouts[userId];

  // 🔔 Notify Gateway
  try {
    // await axios.post("http://localhost:7000/session-expired", { user: userId });
    await axios.post("https://whatsapp-gateway-k2lk.onrender.com/session-expired", { user: userId });
  } catch (err) {
    console.error("⚠️ Failed to notify gateway about session expiration:", err.message);
  }
}, 2 * 60 * 1000);

}

// 🔐 Environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const AUTHORIZE_TOKEN = process.env.AUTHORIZE_TOKEN;


// ✅ Webhook Receiver
app.post("/webhook", async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = msg?.from;
  const msgId = msg?.id;

  if (!msg || !from) return res.sendStatus(200);
  res.sendStatus(200); // Immediate ACK

  if (processedMessages.has(msgId)) {
    console.log(`⚠️ Duplicate ignored: ${msgId}`);
    return;
  }
  processedMessages.add(msgId);

  console.log("📩 Received message:", msg);

  try {
    if (msg.type === "text") {
      const text = msg.text.body.trim();
      await sessionResponseAPI(from, text,msgId);
    } else if (msg.type === "interactive") {
      const title =
        msg?.interactive?.button_reply?.title ||
        msg?.interactive?.list_reply?.title;
      console.log(`🟢 Button clicked: ${title}`);
      await sessionResponseAPI(from, title,msgId);
    }  else if (msg.type === "location") {
      const loc = msg.location;
      console.log(`📍 User shared location:`, loc);

      // ✅ 1️⃣ Prepare full location context for AI
      const locationPayload = {
        name: loc.name || "Unknown",
        address: loc.address || "No address provided",
        latitude: loc.latitude,
        longitude: loc.longitude,
      };

      const locationText = `📍 User shared a location:\nName: ${locationPayload.name}\nAddress: ${locationPayload.address}\nLatitude: ${locationPayload.latitude}\nLongitude: ${locationPayload.longitude}`;

      // ✅ 2️⃣ Send location info to AI session
      
      // ✅ 3️⃣ Send user acknowledgment after AI reply
      await sendTextMessage(
        from,
        `📍 Got your location: *${locationPayload.name}*\n${locationPayload.address}\nLat: ${locationPayload.latitude}\nLng: ${locationPayload.longitude}`
      );

      await sessionResponseAPI(from, JSON.stringify(locationPayload), msgId);
    }

     // 🖼️ IMAGE MESSAGE
    else if (msg.type === "image") {
      const imageData = msg.image;
      const caption = imageData?.caption || "(no caption)";
      const imageId = imageData?.id;

      console.log(`🖼️ Received image from ${from}`);
      console.log(`📄 Caption: ${caption}`);
      console.log(`🪪 Media ID: ${imageId}`);

      // Step 1️⃣: Get image URL
      const imageUrl = await getMediaUrl(imageId);
      console.log("✅ Fetched image URL:", imageUrl);

      // Step 2️⃣: Download image buffer
      const { buffer, mimeType, fileExt } = await downloadMediaBuffer(imageUrl);
      console.log("📥 Downloaded image buffer:", buffer.length, "bytes");

      // Step 3️⃣: Upload image to external API
      const uploadedUrls = await uploadToExternalAPI(
        buffer,
        `${imageId}.${fileExt}`,
        mimeType
      );
      console.log("🌐 Uploaded URLs:", uploadedUrls);

      await sessionResponseAPI(from, uploadedUrls?.[0],msgId);

      // await sendTextMessage(from, `✅ Image uploaded successfully!\n${uploadedUrls?.[0] || ""}`);
    }
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    await sendTextMessage(from, "⚠️ Something went wrong. Please try again.");
  }
});

// ✅ AI Session Handler
async function sessionResponseAPI(to, query, msgId) {
  try {
    resetSessionTimeout(to);

     // 🟡 Start typing indicator
      await sendTypingIndicator(to, msgId, true);

    const formData = new FormData();
    formData.append("query", query);

    if (userSessions[to]) {
      formData.append("sessionId", userSessions[to]);
      console.log(`♻️ Using existing session: ${userSessions[to]}`);
    }

    const agentRes = await axios.post(
      "https://api.gettaskagent.com/api/user/agent/start/69035a0d27a015e1ec3650b3",
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
      (t) => t.tool === "gemini-chat-ai-(session)"
    )?.result?.data;

        console.log("AI Result:", aiResult);

    if (!aiResult?.response) {
      await sendTextMessage(to, "⚠️ No valid AI response received.");
      return;
    }

    let responseText = aiResult.response;
    const sessionId = aiResult.session_id;

    if (sessionId && !userSessions[to]) {
      userSessions[to] = sessionId;
      console.log(`💾 New session saved for ${to}: ${sessionId}`);
    }

    if (typeof responseText === "string") {
  responseText = responseText
    .replace(/```json\s*/gi, "") // remove ```json
    .replace(/```/g, "")         // remove closing ```
    .trim();
}



  if (responseText.startsWith("{")) {
      try {
        const parsed = JSON.parse(responseText);

         // 🔹 Common footer to append to every message type
        const footerText = "\n\nType *1* anytime - return to *main menu*.";

        // if (parsed.response && parsed.Support) {
        //   console.log("📞 Detected 'Support' response (CTA URL)");
        //   return sendCTAButtonMessage(
        //     to,
        //     parsed.response,
        //     "Contact Support",
        //     `mailto:${parsed.Support}`, // or any desired link
        //     "https://upload.wikimedia.org/wikipedia/commons/9/93/Livspace_logo.png", // optional header image
        //     "Livspace Support Team"
        //   );
        // }

        // ✅ Case 1: Buttons
        if (parsed.response && Array.isArray(parsed.buttons)) {
          console.log("🎯 Detected 'buttons' response");
          const options = parsed.buttons.map((b, idx) => ({
            id: `btn_${idx + 1}`,
            title: b,
          }));
          return sendButtonMessage(to,  `${parsed.response}${footerText}`, options);
        }

        // ✅ Case 2: Quick Replies (send as List Message)
        if (parsed.response && Array.isArray(parsed.quick_replies)) {
          console.log("📋 Detected 'quick_replies' response");
          const options = parsed.quick_replies.map((b, idx) => ({
            id: `qr_${idx + 1}`,
            title: b,
          }));
          return sendListMessage(to, `${parsed.response}${footerText}`, options);
        }

        // ✅ Case 3: Location Request
        if (parsed.response && parsed.location_request === true) {
          console.log("📍 Detected 'location_request' response");
          return sendLocationRequestMessage(to, `${parsed.response}${footerText}`);
        }

        // ✅ Case 4: Image Message
        if (parsed.response && parsed.image) {
          console.log("🖼️ Detected 'image' response");
          return sendTextMessage(to, parsed.response);
        }

        // ✅ Case 5: Plain text fallback
        if (parsed.response && !parsed.buttons && !parsed.quick_replies && !parsed.location_request) {
          console.log("💬 Detected plain text response");
          return sendTextMessage(to, `${parsed.response}${footerText}`);
        }
      } catch (err) {
        console.log("⚠️ Not valid JSON, sending plain text...");
      }
    }

    responseText = `${responseText}\n\n\n\nType *1* anytime - return to *main menu*.`;

    // 🧠 Otherwise handle normal messages
    await sendTextMessage(to, responseText);
    

  } catch (err) {
    await sendTypingIndicator(to, msgId, false);
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(to, "⚠️ Something went wrong while generating your design.");
  }
}

// ✅ Typing Indicator Sender
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



// ✅ Send WhatsApp Location Request Message
async function sendLocationRequestMessage(to, text) {
  console.log("📍 Sending location request to:", to);
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      type: "interactive",
      to,
      interactive: {
        type: "location_request_message",
        body: { text },
        action: { name: "send_location" },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ✅ Button message sender
async function sendButtonMessage(to, text, options) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: text },
        action: {
          buttons: options.map(opt => ({
            type: "reply",
            reply: { id: opt.id, title: opt.title },
          })),
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
}

// ✅ List message sender
async function sendListMessage(to, text, options) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Please choose an option" },
        body: { text: text },
        footer: { text: "Livspace Assistant" },
        action: {
          button: "Select Option",
          sections: [
            {
              title: "Available Options",
              rows: options.map(opt => ({
                id: opt.id,
                title: opt.title,
                description: "",
              })),
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
}

// ✅ CTA URL button message sender
async function sendCTAButtonMessage(to, bodyText, buttonLabel, buttonUrl, headerImageUrl, footerText) {
  console.log("📤 Sending CTA URL button message to:", to);
  return axios.post(
    `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        header: {
          type: "image",
          image: { link: headerImageUrl },
        },
        body: { text: bodyText },
        action: {
          name: "cta_url",
          parameters: {
            display_text: buttonLabel,
            url: buttonUrl,
          },
        },
        footer: { text: footerText },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// 🔹 Get media URL from media ID
async function getMediaUrl(mediaId) {
  const res = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  return res.data.url;
}

// 🔹 Download media buffer from media URL
async function downloadMediaBuffer(mediaUrl) {
  const res = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });

  const buffer = Buffer.from(res.data, "binary");
  let mimeType = res.headers["content-type"];
  if (!mimeType || mimeType === "binary/octet-stream") {
    mimeType = mime.lookup(mediaUrl) || "application/octet-stream";
  }
  const fileExt = mime.extension(mimeType) || "bin";

  return { buffer, mimeType, fileExt };
}

// 🔹 Upload to external API and get URLs
async function uploadToExternalAPI(buffer, filename, mimeType) {
  const formData = new FormData();
  formData.append("files", buffer, { filename, contentType: mimeType });

  const res = await axios.post(
    "https://api.gettaskagent.com/api/file/upload",
    formData,
    { headers: { ...formData.getHeaders() } }
  );

  const uploadedUrls = res.data?.files?.map((f) => f.Location);
  return uploadedUrls;
}

// ✅ Text message fallback
async function sendTextMessage(to, message) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
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

// ✅ Basic root endpoint
app.get('/', (req, res)=>{
    res.send("Welcome to LivSpace Gateway!")
})


app.listen(process.env.PORT, () => {
  console.log(`✅ WhatsApp RAG bot running on port ${process.env.PORT}`);
});;
