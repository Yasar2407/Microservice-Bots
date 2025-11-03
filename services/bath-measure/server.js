require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const mime = require("mime-types");

const app = express();
app.use(express.json());

// ✅ WhatsApp Webhook Handler
const processedMessages = new Set(); // 🧠 track processed message IDs

let userDimensions = {}; // 🧠 store user length*breadth by phone number

// ✅ Webhook Verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
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

      if (text === "hi") {
        await sendTextMessage(
          from,
          "👋 Hi! I’m *AI Bathroom Designer*.\nPlease enter your Bathroom size in this format: _Length*Breadth_ (e.g., 10*12).\n\n\n\nType *1* anytime - return to *main menu*."
        );
      } else if (/^\d+(\s*[\*x, ]\s*)?\d+$/.test(text)) {
        // ✅ Valid dimension format
        const parts = text.split(/[\*x, ]+/).map(Number);
        const [length, breadth] = parts;
        userDimensions[from] = { length, breadth };

        await sendProductSelectionButtons(from);
      } else {
        await sendFallbackMessage(from);
      }
    }

    // ✅ Interactive reply handler
    else if (msg.type === "interactive") {
      const id =
        msg?.interactive?.button_reply?.id ||
        msg?.interactive?.list_reply?.id;
      await handleInteractiveReply(from, id,msgId);
    }
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    await sendFallbackMessage(from);
  }

});


// 🔹 Send product selection buttons
async function sendProductSelectionButtons(to) {
  await axios.post(
    `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Please select your preferred product 👇" },
        footer: { text: "AISmart Interiors 🧠 | Type *1* anytime - return to *main menu*." },
        action: {
          buttons: [
            { type: "reply", reply: { id: "sgg", title: "SGG Aspira Dawn" } },
            { type: "reply", reply: { id: "classic", title: "Classic" } },
            { type: "reply", reply: { id: "matrix", title: "Matrix" } },
            // { type: "reply", reply: { id: "coral", title: "Coral" } },
            // { type: "reply", reply: { id: "boho", title: "Boho" } },
          ],
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
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
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/media`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
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

// 🔹 Send interactive design reply with buttons
async function sendInteractiveDesignReply(to, mediaId, query) {
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
          caption: `${query}\n\n🎨 Here’s your AI-generated design preview!`,
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

// 🔹 Handle interactive reply (button click)
async function handleInteractiveReply(to, id,msgId) {
 const productMap = {
    sgg: {
      name: "SGG Aspira Dawn",
      imageUrl: "https://balconey202.s3.amazonaws.com/uploads/1761376609146_Screenshot%202025-10-25%20124129.png",
    },
    classic: {
      name: "CLASSIC",
      imageUrl: "https://balconey202.s3.amazonaws.com/uploads/1761376609129_Screenshot%202025-10-25%20124059.png",
    },
    matrix: {
      name: "MATRIX",
      imageUrl: "https://balconey202.s3.amazonaws.com/uploads/1761376609137_Screenshot%202025-10-25%20124110.png",
    },
    // coral: {
    //   name: "CORAL",
    //   imageUrl: "https://balconey202.s3.amazonaws.com/uploads/1761376609118_Screenshot%202025-10-25%20124040.png",
    // },
    // boho: {
    //   name: "ВОНО",
    //   imageUrl: "https://balconey202.s3.amazonaws.com/uploads/1761376609141_Screenshot%202025-10-25%20124116.png",
    // },
  };


  const selectedProduct = productMap[id];

  console.log('SELECTED-PROD:',selectedProduct);
  

  if (selectedProduct) {
          const mediaId = await uploadImageToWhatsApp(selectedProduct.imageUrl); 

        // ✅ Send the uploaded image via WhatsApp message
      await sendWhatsAppMessage(to, mediaId, `✅ Great choice! *${selectedProduct.name}* is being processed — this may take a moment... `);
    // await sendTextMessage(
    //   to,
    //   `✅ Successfully selected *${selectedProduct..name}*. Please wait while we process your design...`
    // );

    // Prepare and send API payload
    const dims = userDimensions[to] || { length: "N/A", breadth: "N/A" };
    const query = `Bathroom length: ${dims.length} feet and inches, width: ${dims.breadth} feet and inches. Selected product: ${selectedProduct.name}`;

     // 🟡 Start typing indicator
      await sendTypingIndicator(to, msgId, true);

    const formData = new FormData();
    formData.append("query", query);

    try {
      const agentResponse = await axios.post(
        "https://api.gettaskagent.com/api/user/agent/start/69006d1b27a015e1ec35d0af",
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
            Authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4YmZmYjM2OGQ5MjkwZjlkOWU4MDA4MSIsInVzZXJUeXBlIjoiY3VzdG9tZXIiLCJpYXQiOjE3NjAzMzU3ODcsImV4cCI6MTc2MjkyNzc4N30.aX7mjgBALqL33aeMd_k3p9_yp8TIcAkj1mhP1TeIYAQ`,
            subdomain: "construex",
            "x-user-type": "customer",
          },
        }
      );

          // 🟢 Stop typing indicator
    await sendTypingIndicator(to, msgId, false);

      console.log("🤖 Agent API success:", agentResponse.data);

      const aiResult = agentResponse?.data?.workflowlog?.tasks?.find(
        (task) => task.tool === "multi-image-upload-and-generate"
      )?.result?.data;

      console.log("AI Result:", aiResult);

      const imageUrl = aiResult?.s3_url;

      const mediaId = await uploadImageToWhatsApp(imageUrl); 

        // ✅ Send the uploaded image via WhatsApp message
      await sendInteractiveDesignReply(to, mediaId, query);

    } catch (err) {
      console.error(
        "❌ Agent API error:",
        err.response?.data || err.message
      );
      await sendTextMessage(
        to,
        "⚠️ Something went wrong while contacting the design engine. Please try again."
      );
    }
  } else {
    await sendFallbackMessage(to);
  }
}

// 🔹 Reusable text message sender
async function sendTextMessage(to, message) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// 🔹 Send WhatsApp message with uploaded media
async function sendWhatsAppMessage(to, mediaId, caption) {
  await axios.post(
    `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: {
        id: mediaId,
        caption: caption || "",
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ✅ Typing Indicator Sender
async function sendTypingIndicator(to, messageId, isTyping) {
  try {
    console.log(`💬 Typing indicator ${isTyping ? "on" : "off"} for ${to}`);

    await axios.post(
      `https://graph.facebook.com/v24.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read", // ✅ Required
        message_id: messageId, // ✅ Required from webhook
        typing_indicator: isTyping ? { type: "text" } : undefined, // typing off happens automatically when you send the message
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.warn("⚠️ Typing indicator error:", err.response?.data || err.message);
  }
}

// 🔹 Fallback for unknown messages
async function sendFallbackMessage(to) {
  return sendTextMessage(
    to,
    "⚙️ I’m not sure what you meant. Try typing one of the options I shared earlier, or say 'help' to see what I can do!"
  );
}


// 🔹 Send confirmation with uploaded image
// async function sendImageReply(to, uploadedUrls, caption, imageId) {
//   const imageUrl = uploadedUrls?.[0];
//   await axios.post(
//     `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
//     {
//       messaging_product: "whatsapp",
//       recipient_type: "individual",
//       to,
//       type: "interactive",
//       interactive: {
//         type: "button",
//         header: { type: "image", image: { link: imageUrl } },
//         body: {
//           text: `✅ Image received!\nCaption: ${caption}\nWould you like to generate design ideas?`,
//         },
//         footer: { text: "AI Home Designer • Smart Interiors 🧠" },
//         action: {
//           buttons: [
//             {
//               type: "reply",
//               reply: { id: "generate-designs", title: "✨ Generate Ideas" },
//             },
//             {
//               type: "reply",
//               reply: { id: "upload-another", title: "📤 Upload Another" },
//             },
//           ],
//         },
//       },
//     },
//     {
//       headers: {
//         Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
//         "Content-Type": "application/json",
//       },
//     }
//   );
// }

const PORT = process.env.PORT || 8000;
app.listen(PORT, () =>
  console.log(`🚀 WhatsApp bot running on port ${PORT}`)
);
