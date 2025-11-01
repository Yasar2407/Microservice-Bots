require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { spawn } = require("child_process");
const bodyParser = require("body-parser");
const path = require("path");


const app = express();
app.use(bodyParser.json());

const { VERIFY_TOKEN, ACCESS_TOKEN, PHONE_NUMBER_ID } = process.env;

// WhatsApp Send Message Function
async function sendTextMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
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
    console.error("❌ Failed to send message:", err.response?.data || err.message);
  }
}

// Define microservices
const MICROSERVICES = {
  ai: { port: 7003, path: "../services/ai-session/server.js" },
  bath: { port: 7001, path: "../services/bath-measure/server.js" },
  livspace: { port: 7002, path: "../services/livSpace/server.js" },
};


// Auto start services safely using absolute paths
// Object.entries(MICROSERVICES).forEach(([key, svc]) => {
//   const servicePath = path.resolve(__dirname, svc.path);
//   console.log(`🚀 Starting ${key} service on port ${svc.port} → ${servicePath}`);

//   const child = spawn("node", [servicePath], {
//     stdio: "inherit",
//     shell: true, // allows cross-platform execution
//   });

//   child.on("error", (err) => {
//     console.error(`❌ Failed to start ${key} service:`, err.message);
//   });

//   child.on("exit", (code) => {
//     console.log(`⚠️ ${key} service exited with code ${code}`);
//   });
// });


// ✅ Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ✅ Webhook message handler
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = msg?.from;
  const text = msg?.text?.body?.trim()?.toLowerCase() || "";

  if (!msg || !from) return;

  // 🟢 Step 1: Menu flow
  if (text === "hi" || text === "hello" || text === "menu") {
    console.log("🟢 Entered MENU flow");
    const menuMessage = `👋 Welcome!\nPlease choose an option:\n\n1️⃣ Bathroom Design\n2️⃣ livspace\n3️⃣ AI Session Chat\n\nType number or name to continue.`;
    await sendTextMessage(from, menuMessage);
    console.log("✅ Menu message sent");
    return;
  }

  // 🟢 Step 2: Routing logic
  let route = null;
  if (text === "1" || text.includes("bath")) route = "bath";
  else if (text === "2" || text.includes("liv") || text.includes("livspace")) route = "livspace";
  else if (text === "3" || text.includes("ai")) route = "ai";

  if (!route) {
    await sendTextMessage(from, "⚠️ Invalid option. Please type 'menu' to see options again.");
    return;
  }

  console.log(`➡️ Forwarding message to ${route} service on port ${MICROSERVICES[route].port}`);

  try {
    await axios.post(`http://localhost:${MICROSERVICES[route].port}/webhook`, req.body);
  } catch (err) {
    console.error("❌ Routing error:", err.message);
    await sendTextMessage(from, "❌ Service temporarily unavailable. Please try again later.");
  }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`✅ Gateway running on port ${PORT}`));
