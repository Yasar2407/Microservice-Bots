require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const mime = require("mime-types");
const { parse } = require("dotenv");

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
    }  else if (msg.type === "interactive") {
      const title =
        msg?.interactive?.button_reply?.title ||
        msg?.interactive?.list_reply?.title;
      console.log(`🟢 Button clicked: ${title}`);
      await sessionResponseAPI(from, title,msgId);
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

       else if (msg.type === "document") {
      const docData = msg.document;
      const filename = docData?.filename || "unknown";
      const mimeType = docData?.mime_type;
      const mediaId = docData?.id;

      console.log(`📄 Document message received from ${from}, ID: ${mediaId}`);
      console.log(`🗂️ Filename: ${filename}`);
      console.log(`📦 MIME Type: ${mimeType}`);

      // Step 1️⃣: Get document URL
      const docUrl = await getMediaUrl(mediaId);
      console.log("✅ Fetched document URL:", docUrl);

      // Step 2️⃣: Download document buffer
      const { buffer, fileExt } = await downloadMediaBuffer(docUrl);
      console.log("📥 Downloaded document buffer:", buffer.length, "bytes");

      // Step 3️⃣: Upload to external API
      const uploadedUrls = await uploadToExternalAPI(buffer, filename, mimeType);
      console.log("🌐 Uploaded Document URLs:", uploadedUrls);

    //   await sendTextMessage(
    //     from,
    //     `📎 Document uploaded successfully!\n🗂️ File: ${filename}\n${uploadedUrls?.[0] || ""}`
    //   );
      //  await sessionResponseAPI(from, uploadedUrls);

      if (mimeType?.startsWith("audio/") || /\.(mp3|m4a|wav|ogg)$/i.test(filename)) {
    console.log("🎙️ Document detected as audio — starting transcription...");
    const transcribedText = await transcribeAudio(from, uploadedUrls);

    if (transcribedText) {
      await sessionResponseAPI(from, transcribedText, msgId);
    } else {
      await sendTextMessage(from, "⚠️ Couldn't transcribe your audio. Please try again.");
    }
  } else {
    // 📤 Otherwise, treat as normal document
    await sessionResponseAPI(from, uploadedUrls?.[0], msgId);
  }
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
     if (userSessions[to]) {
      formData.append("sessionId", userSessions[to]);
      console.log(`♻️ Using existing session: ${userSessions[to]}`);
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
        console.log('');
        
         // 🔹 Common footer to append to every message type
        const footerText = "\n\nType *1* anytime - return to *main menu*.";

        // ✅ Case 1: Buttons
        if (parsed.response && Array.isArray(parsed.buttons)) {
          console.log("🎯 Detected 'buttons' response");
          const options = parsed.buttons.map((b, idx) => ({
            id: `btn_${idx + 1}`,
            title: b,
          }));
          return sendButtonMessage(to, `${parsed.response}${footerText}`, options);
        }

        // ✅ Case 2: Quick Replies (send as List Message)
        if (parsed.response && Array.isArray(parsed.quick_replies)) {
          console.log("📋 Detected 'quick_replies' response");
          const limitedReplies = parsed.quick_replies.slice(0, 10);
          const options = limitedReplies.map((b, idx) => ({
            id: `qr_${idx + 1}`,
            title: b,
          }));
          return sendListMessage(to, `${parsed.response}${footerText}`, options);
        }


         // ✅ Case 4: Image Message
        if (parsed.response && parsed.image) {
          console.log("🖼️ Detected 'image' response");
          return sendTextMessage(to, `${parsed.response}${footerText}`);
        }

        // ✅ Case 5: Audio Message
        if (parsed.response && parsed.audio) {
          console.log("🎵 Detected 'audio' response");
          return sendTextMessage(to, `${parsed.response}${footerText}`);
        }

          // ✅ Case 6: Final input detection
         if (parsed.response && parsed.infos) {
          console.log("🏁 Detected query calling estimate generation API...");

          const response = parsed.response;
           await sendTextMessage(to, response);

          // ✅ Send only the `fullQuery` field
          const image = parsed.infos.imageUrl || "";
          const fullQuery = parsed.infos.query;
          if (fullQuery) {
             await callAgentAPI(to, fullQuery,image, msgId);
          } else {
            console.warn("⚠️ No fullQuery found in final_input.");
            await sendTextMessage(to, "⚠️ Missing project details. Please try again.");
          }
        
          // 🧹 Clear the user's session after estimate generation
          if (userSessions[to]) {
            console.log(`🧹 Clearing session for ${to}: ${userSessions[to]}`);
            delete userSessions[to];
          }
        
          return;
        }


        // ✅ Case 7: Plain text fallback
        if (parsed.response && !parsed.buttons && !parsed.quick_replies && !parsed.location_request && !parsed.image_url && !parsed.audio  && !parsed.infos) {
          console.log("💬 Detected plain text response");
          return sendTextMessage(to, `${parsed.response}${footerText}`);
        }
      } catch (err) {
        console.log("⚠️ Not valid JSON, sending plain text...");
      }
    }

    responseText = `${responseText}\n\n\n\nType *1* anytime - return to *main menu*.`;

    // 📨 Always send only the "response" part to WhatsApp
    await sendTextMessage(to, responseText);


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


async function callAgentAPI(to, query, image, msgId) {
  try {
    // 🟡 Start typing indicator
    await sendTypingIndicator(to, msgId, true);

    console.log('QUERY:',query);
    

    const formData = new FormData();
    formData.append("query", query);

    if (image) {
      formData.append("image", image);
    }

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

    console.log("🤖 Agent API success:", agentRes.data);

    // const aiResult = agentRes?.data?.workflowlog?.tasks?.find(
    //   (t) => t.tool === "generate-image(1)"
    // )?.result?.data;

    const tasks = agentRes?.data?.workflowlog?.tasks || [];

    const imageTask = tasks.find((t) =>
    t.tool?.toLowerCase().includes("generate-image") ||
    t.tool?.toLowerCase().includes("multi-image-upload-and-generate")
    );

  const aiResult = imageTask?.result?.data;

  console.log("AI Result:", aiResult);
  
    if (!Array.isArray(aiResult) || aiResult.length === 0) {
  throw new Error("No AI result data found or invalid format.");
}

  // Collect cards for carousel
    const carouselCards = [];

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
    // await sendInteractiveDesignReply(to, mediaId, promptText);
    // console.log(`✅ Sent interactive design reply for iteration ${iteration?.iteration}`);

    carouselCards.push({
          headerAssetId: mediaId,
          headerFormat: "image",
          bodyText: promptText,
          urlButtonText: "View Full Image",
          urlButtonUrl: imageUrl,
    });

    // 3️⃣ Optional: Delay between sends (to avoid WhatsApp rate limits)
    await new Promise((res) => setTimeout(res, 2000));

  } catch (err) {
    console.error(`❌ Error processing iteration ${iteration?.iteration}:`, err.message);
  }

   if (carouselCards.length > 0) {
      await sendMediaCarouselURL(to,
        "ai_design_carousel_", // your approved template
        "en_US",
        [],
        carouselCards
      );
      console.log("✅ Sent final media carousel with all AI designs!");
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
        footer: { text: "Home Designer Assistant" },
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



// ✅ Media-Card Carousel Template Sender (URL Buttons Only)
async function sendMediaCarouselURL(to, templateName, languageCode, bodyVariables, cardsData) {
  console.log("📤 Sending Media Carousel with URL buttons to:", to);

  try {
    // Construct body component
    const components = [
      {
        type: "body",
        parameters: bodyVariables.map(text => ({
          type: "text",
          text
        }))
      },
      {
        type: "carousel",
        cards: cardsData.map((card, idx) => ({
          card_index: idx,
          components: [
            // Header: image or video
            {
              type: "header",
              parameters: [
                {
                  type: card.headerFormat,
                  [card.headerFormat]: { id: card.headerAssetId }
                }
              ]
            },
            // Optional card body text
            ...(card.bodyText
              ? [{
                  type: "body",
                  parameters: [{ type: "text", text: card.bodyText }]
                }]
              : []),
            // URL Button (only)
            ...(card.urlButtonUrl && card.urlButtonText
              ? [{
                  type: "button",
                  sub_type: "url",
                  index: "0",
                  parameters: [{ type: "text", text: card.urlButtonUrl }]
                }]
              : [])
          ]
        }))
      }
    ];

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components
      }
    };

    const response = await axios.post(
      `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Media Carousel with URL buttons sent:", response.data);
    return response.data;

  } catch (err) {
    console.error("❌ Error sending Media Carousel with URL buttons:", err.response?.data || err.message);
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