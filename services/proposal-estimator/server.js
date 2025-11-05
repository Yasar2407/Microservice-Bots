require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const mime = require("mime-types");
const PDFDocument = require("pdfkit");
const { renderTemplate, htmlTemplate } = require("./proposalRenderer");




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

    // 🎧 AUDIO (VOICE) MESSAGE
    else if (msg.type === "audio" && msg.audio?.voice) {
      const mediaId = msg.audio.id;
      console.log(`🎙️ Voice message received from ${from}, ID: ${mediaId}`);

      // Step 1️⃣: Get audio URL
      const audioUrl = await getMediaUrl(mediaId);
      console.log("✅ Fetched audio URL:", audioUrl);

      // Step 2️⃣: Download audio buffer
      const { buffer, mimeType, fileExt } = await downloadMediaBuffer(audioUrl);
      console.log("📥 Downloaded audio buffer:", buffer.length, "bytes");

      // Step 3️⃣: Upload to external API
      const uploadedUrls = await uploadToExternalAPI(
        buffer,
        `${mediaId}.${fileExt}`,
        mimeType
      );
      console.log("🌐 Uploaded Audio URLs:", uploadedUrls);

      const transcribedText = await transcribeAudio(from, uploadedUrls);
      await sessionResponseAPI(from, transcribedText,msgId);

      // await sendTextMessage(from, `🎧 Voice note uploaded!\n${uploadedUrls?.[0] || ""}`);

    }

    // 🎥 VIDEO MESSAGE
    else if (msg.type === "video") {
      const videoData = msg.video;
      const caption = videoData?.caption || "(no caption)";
      const mediaId = videoData?.id;

      console.log(`🎥 Video message received from ${from}, ID: ${mediaId}`);
      console.log(`📝 Caption: ${caption}`);

      // Step 1️⃣: Get video URL
      const videoUrl = await getMediaUrl(mediaId);
      console.log("✅ Fetched video URL:", videoUrl);

      // Step 2️⃣: Download video buffer
      const { buffer, mimeType, fileExt } = await downloadMediaBuffer(videoUrl);
      console.log("📥 Downloaded video buffer:", buffer.length, "bytes");

      // Step 3️⃣: Upload to external API
      const uploadedUrls = await uploadToExternalAPI(
        buffer,
        `${mediaId}.${fileExt}`,
        mimeType
      );

      console.log("🌐 Uploaded Video URLs:", uploadedUrls);
    //   await sendTextMessage(from, `🎬 Video uploaded successfully!\n${uploadedUrls?.[0] || ""}`);
    // await sessionResponseAPI(from, uploadedUrls);
    }

    // 📄 DOCUMENT MESSAGE
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
      "https://api.gettaskagent.com/api/user/agent/start/69085f2a27a015e1ec36ac83",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
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

        // ✅ Case 3: Location Request
        if (parsed.response && parsed.location_request === true) {
          console.log("📍 Detected 'location_request' response");
          return sendLocationRequestMessage(to, `${parsed.response}${footerText}`);
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
         if (parsed.response && parsed.final_input) {
          console.log("🏁 Detected final input, calling estimate generation API...");
        
          // ✅ Send only the `fullDescription` field
          const fullDescription = parsed.final_input.fullDescription;
          if (fullDescription) {
            await estimateGenerationAPI(to, fullDescription, msgId);
          } else {
            console.warn("⚠️ No fullDescription found in final_input.");
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
        if (parsed.response && !parsed.buttons && !parsed.quick_replies && !parsed.location_request && !parsed.image_url && !parsed.audio  && !parsed.final_input) {
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

// ✅Estimate generation API
async function estimateGenerationAPI(to, query, msgId) {
  try {
    resetSessionTimeout(to);

     // 🟡 Start typing indicator
      await sendTypingIndicator(to, msgId, true);

    const formData = new FormData();
    formData.append("query", query);

    const agentRes = await axios.post(
      "https://api.gettaskagent.com/api/user/agent/start/68a5a1fc71707acbfdd1e08f",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
          subdomain: "matbook",
          "x-user-type": "customer",
        },
      }
    );

     // 🟢 Stop typing indicator
    await sendTypingIndicator(to, msgId, false);

    const estimateResult = agentRes?.data?.workflowlog?.tasks?.find(
      (t) => t.tool === "geminichat-tool"
    )?.result?.data;

        console.log("AI Result:", estimateResult);

    if (!estimateResult) {
      await sendTextMessage(to, "⚠️ No valid AI response received.");
      return;
    }


    await proposalGenerationAPI(to, estimateResult,msgId);



    

  } catch (err) {
    await sendTypingIndicator(to, msgId, false);
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(to, "⚠️ Something went wrong while generating your design.");
  }
}


// ✅Proposal generation API
async function proposalGenerationAPI(to, query, msgId) {
  try {
    resetSessionTimeout(to);

     // 🟡 Start typing indicator
      await sendTypingIndicator(to, msgId, true);

    const formData = new FormData();
    formData.append("query", typeof query === "object" ? JSON.stringify(query) : query);

    const agentRes = await axios.post(
      "https://api.gettaskagent.com/api/user/agent/start/68b7ec00da797cdad642fae6",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
          subdomain: "matbook",
          "x-user-type": "customer",
        },
      }
    );

     // 🟢 Stop typing indicator
    await sendTypingIndicator(to, msgId, false);

    const proposalResult = agentRes?.data?.workflowlog?.tasks?.find(
      (t) => t.tool === "geminichat-tool"
    )?.result?.data;

      console.log("AI Result:", proposalResult);

    if (!proposalResult) {
      await sendTextMessage(to, "⚠️ No valid AI response received.");
      return;
    }

    await templateToSharedAPI(to, query, proposalResult, msgId);

  } catch (err) {
    await sendTypingIndicator(to, msgId, false);
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(to, "⚠️ Something went wrong while generating your design.");
  }
}

// ✅Estimate generation API
async function templateToSharedAPI(to, query, proposalResult, msgId) {
  try {
    resetSessionTimeout(to);

     // 🟡 Start typing indicator
      await sendTypingIndicator(to, msgId, true);

    const formData = new FormData();
    formData.append("estimationResult", typeof query === "object" ? JSON.stringify(query) : query);
    formData.append("proposalResult", typeof proposalResult === "object" ? JSON.stringify(proposalResult) : proposalResult);

    const agentRes = await axios.post(
      "https://api.gettaskagent.com/api/user/agent/start/690a149a143439d4392c57db",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
          subdomain: "construex",
          "x-user-type": "customer",
        },
      }
    );

     // 🟢 Stop typing indicator
    await sendTypingIndicator(to, msgId, false);

    const sharedResult = agentRes?.data?.workflowlog?.tasks?.find(
      (t) => t.tool === "shared-template-creator"
    )?.result?.data;

      console.log("AI Result:", sharedResult);

    if (!sharedResult) {
      await sendTextMessage(to, "⚠️ No valid AI response received.");
      return;
    }


    const sharedLink = sharedResult?.data;

    await sendCTAButtonMessage(to,"✅ Your proposal document is ready! Click below to view and share it.","View Proposal",sharedLink,"Thank you for using our service! 🚀")

    await sendTextMessage(
    to,
    `✅ *Proposal Document Uploaded Successfully!*\n🌐 *View Proposal:* ${sharedLink}\n\nThank you for using our service! 🚀`
  );



    

  } catch (err) {
    await sendTypingIndicator(to, msgId, false);
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(to, "⚠️ Something went wrong while generating your design.");
  }
}


// ✅ CTA URL Button Message Sender
async function sendCTAButtonMessage(to, bodyText, buttonLabel, buttonUrl, footerText) {
  console.log("📤 Sending CTA URL button message to:", to);

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: bodyText },
          footer: { text: footerText },
          action: {
            name: "cta_url",
            parameters: {
              display_text: buttonLabel,
              url: buttonUrl,
            },
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

    console.log("✅ CTA URL message sent:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ Error sending CTA button:", err.response?.data || err.message);
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

// 🔹 Upload media (image, video, audio, document) to WhatsApp and return media ID
async function uploadMediaToWhatsApp(mediaUrl, type) {
  try {
    if (!["image", "video", "audio", "document"].includes(type)) {
      throw new Error(`Invalid media type: ${type}`);
    }

    // 1️⃣ Download the media from the given URL
    const mediaResponse = await axios.get(mediaUrl, { responseType: "arraybuffer" });

    // 2️⃣ Detect MIME type
    let mimeType = mediaResponse.headers["content-type"];
    if (!mimeType || mimeType === "binary/octet-stream") {
      const guessedMime = mime.lookup(mediaUrl);
      mimeType = guessedMime || getDefaultMime(type);
    }

    // 3️⃣ Determine file extension
    const fileExt = mime.extension(mimeType) || getDefaultExt(type);

    console.log(`🧾 Uploading ${type} to WhatsApp with type: ${mimeType}`);

    // 4️⃣ Prepare form data
    const formData = new FormData();
    formData.append("file", Buffer.from(mediaResponse.data), {
      filename: `${type}.${fileExt}`,
      contentType: mimeType,
    });
    formData.append("type", mimeType);
    formData.append("messaging_product", "whatsapp");

    // 5️⃣ Upload to WhatsApp Graph API
    const uploadRes = await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/media`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          ...formData.getHeaders(),
        },
      }
    );

    console.log(`✅ ${type} uploaded successfully:`, uploadRes.data);
    return uploadRes.data.id; // return the WhatsApp media ID

  } catch (err) {
    console.error(`❌ uploadMediaToWhatsApp (${type}) error:`, err.response?.data || err.message);
    throw err;
  }
}

// 🔹 Send media message (image, video, audio, document) by uploading first
async function sendMediaMessage(to, mediaUrl, type, caption = "") {
  try {
    const mediaId = await uploadMediaToWhatsApp(mediaUrl, type);
    const payload = {
      messaging_product: "whatsapp",
      to,
      type,
      [type]: { id: mediaId, caption },
    };

    const res = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`📤 Sent ${type} message:`, res.data);
  } catch (err) {
    console.error(`❌ sendMediaMessage (${type}) error:`, err.response?.data || err.message);
  }
}

// transcribe audio file using AI agent
async function transcribeAudio(to, uploadedUrls) {
  try {
    const formData = new FormData();
    if (Array.isArray(uploadedUrls)) {
  uploadedUrls.forEach((url) => {
    formData.append("audio", url);
  });
} else {
  formData.append("audio", uploadedUrls);
}

    // 🔹 Call AI agent
    const agentRes = await axios.post(
      "https://api.gettaskagent.com/api/user/agent/start/69087acf27a015e1ec36b2e7",
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

    console.log("🤖 Agent API success:", agentRes.data);

    const aiResult = agentRes?.data?.workflowlog?.tasks?.find(
      (t) => t.tool === "transcribe-audio"
    )?.result?.data?.desired_response;

    console.log("AI Result:", aiResult);

    return aiResult;

  } catch (err) {
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(
      to,
      "⚠️ Something went wrong while generating your design. Please try again later."
    );
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
        footer: { text: "Estimate Assistant" },
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

// 🔹 Helper: Default MIME types
function getDefaultMime(type) {
  switch (type) {
    case "image": return "image/jpeg";
    case "video": return "video/mp4";
    case "audio": return "audio/ogg";
    case "document": return "application/pdf";
    default: return "application/octet-stream";
  }
}

// 🔹 Helper: Default file extensions
function getDefaultExt(type) {
  switch (type) {
    case "image": return "jpg";
    case "video": return "mp4";
    case "audio": return "ogg";
    case "document": return "pdf";
    default: return "bin";
  }
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

app.listen(process.env.PORT, () => {
  console.log(`✅ WhatsApp RAG bot running on port ${process.env.PORT}`);
});