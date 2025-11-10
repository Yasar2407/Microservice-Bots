require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const sharp = require("sharp");
const mime = require("mime-types");
const { randomUUID } = require("crypto");
const {
  extractFacetOptions,
  buildDesignSearchPayload,
  normalizeFacetCounts,
} = require("./service/designSearchService");
const { createAgentQueryPayload } = require("./service/sessionPayload");
const {
  extractDesignResponseFromAgent,
  extractAgentSummaryText,
} = require("./utils/agentResponseUtils");
const {
  getInspirationImageUrl,
  extractProductIdsFromInspiration,
  toTitleCase,
} = require("./utils/inspirationUtils");

const app = express();
app.use(express.json());


// ✅ WhatsApp Webhook Handler
const processedMessages = new Set(); // 🧠 track processed message IDs



const userSessions = {};  // 🧠 Store sessionId by phone number
const userSteps = {};
const userFacets = {};
const userDesignStates = {};
const userFacetContext = {};
const userInspirationContext = {};
const userEditSessions = {};

const sessionTimeouts = {}; // 🕒 to track user inactivity timers
const editSessionTimeouts = {};
const EDIT_SESSION_TIMEOUT_MS = 2 * 60 * 1000;

function clearUserState(userId) {
  resetEditSession(userId);
  delete userSessions[userId];
  delete userSteps[userId];
  delete userFacets[userId];
  delete userDesignStates[userId];
  delete userFacetContext[userId];
  delete userInspirationContext[userId];
}

function initializeUserState(userId) {
  userSessions[userId] = generateSessionId();
  userDesignStates[userId] = createInitialDesignState();
  userFacets[userId] = {};
  userSteps[userId] = null;
  delete userFacetContext[userId];
  delete userInspirationContext[userId];
}

function resetUserState(userId) {
  clearUserState(userId);
  initializeUserState(userId);
}

const MIN_INSPIRATION_PREVIEW_COUNT = 4;
const INSPIRATION_PREVIEW_RETRY_MS = 30 * 1000;


// ✅ Utility: clear and set new timer for each user
function resetSessionTimeout(userId) {
  // clear any existing timeout
  if (sessionTimeouts[userId]) {
    clearTimeout(sessionTimeouts[userId]);
  }

  // start a new 2-minute timer (120000 ms)
  sessionTimeouts[userId] = setTimeout(async() => {
    console.log(
      `⏰ Session expired for ${userId}. Removing from userSessions.`
    );
    clearUserState(userId);
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





function clearEditSessionTimeout(userId) {
  if (editSessionTimeouts[userId]) {
    clearTimeout(editSessionTimeouts[userId]);
    delete editSessionTimeouts[userId];
  }
}

function scheduleEditSessionTimeout(userId) {
  clearEditSessionTimeout(userId);

  editSessionTimeouts[userId] = setTimeout(() => {
    console.log(`⏰ Edit session expired for ${userId}`);

    if (userEditSessions[userId]) {
      delete userEditSessions[userId];
      sendTextMessage(userId, "⏰ Edit mode closed after 2 minutes with no reply.").catch(
        (err) => console.error("⚠️ Edit timeout notification failed:", err.message)
      );
    }
  }, EDIT_SESSION_TIMEOUT_MS);
}

function touchEditSession(userId) {
  const session = userEditSessions[userId];
  if (!session) return;

  session.lastInteractionAt = Date.now();
  scheduleEditSessionTimeout(userId);
}

async function startEditPreferenceSession(userId, options = {}) {
  resetEditSession(userId);

  const now = Date.now();
  const {
    primaryImageUrl = null,
    primaryCaption = null,
    primaryImageMediaId = null,
    primaryImageWhatsAppId = null,
  } = options;

  const uploadedImages = [];

  if (primaryImageUrl) {
    uploadedImages.push({
      uploadedUrl: primaryImageUrl,
      sourceUrl: primaryImageUrl,
      isPrimary: true,
      caption: primaryCaption || null,
      mediaId: primaryImageMediaId || null,
      whatsAppMediaId: primaryImageWhatsAppId || primaryImageMediaId || null,
    });
  }

  userEditSessions[userId] = {
    startedAt: now,
    lastInteractionAt: now,
    uploadedImages,
    pendingQuery: null,
    actions: {},
  };

  scheduleEditSessionTimeout(userId);

  const introLines = [
    "✏️ Edit mode enabled.",
    "Upload reference photos or type your updated request.",
    "Type *7* anytime to exit.",
  ];

  if (primaryImageUrl) {
    introLines.unshift("📌 Current inspiration pinned as the main image above.");
  }

  // if (initialQuery) {
  //   introLines.push(`Starting request:\n${initialQuery}`);
  // }

  await sendTextMessage(
    userId,
    introLines.join("\n\n")
  );

  if (uploadedImages.length > 0 ) {
    await sendEditSessionSummary(userId);
  }
}

function resetEditSession(userId) {
  clearEditSessionTimeout(userId);
  if (userEditSessions[userId]) {
    delete userEditSessions[userId];
  }
}

function getUserUploadedImageCount(session) {
  if (!session?.uploadedImages?.length) return 0;
  return session.uploadedImages.filter((img) => !img.isPrimary).length;
}

async function handleEditSessionText(userId, rawText, meta = {}) {
  const session = userEditSessions[userId];
  if (!session) return false;

  const text = typeof rawText === "string" ? rawText.trim() : "";
  touchEditSession(userId);

  if (!text) {
    await sendTextMessage(userId, "Share the changes you'd like or type *7* to exit edit mode.");
    return true;
  }

  if (text === "7") {
    resetEditSession(userId);
    await sendTextMessage(userId, "✅ Edit mode closed. Your selections stay as-is.");
    return true;
  }

  if (["generate", "submit"].includes(text.toLowerCase())) {
    await handleEditSessionGenerate(userId, {
      messageId: typeof meta.messageId === "string" ? meta.messageId : null,
    });
    return true;
  }

  session.pendingQuery = text;
  await sendEditSessionSummary(userId);
  return true;
}

async function handleEditSessionAction(userId, actionId, meta = {}) {
  const session = userEditSessions[userId];
  if (!session) return false;

  const normalized = String(actionId || "").toLowerCase();
  const actionType = session.actions?.[normalized] || normalized;

  if (!actionType) {
    return false;
  }

  touchEditSession(userId);

  if (actionType === "generate") {
    await handleEditSessionGenerate(userId, {
      messageId: typeof meta.messageId === "string" ? meta.messageId : null,
    });
    return true;
  }

  if (actionType === "cancel") {
    resetEditSession(userId);
    await sendTextMessage(userId, "Edit mode cancelled.");
    return true;
  }

  return false;
}

async function handleEditSessionGenerate(userId, options = {}) {
  const session = userEditSessions[userId];
  if (!session) return false;

  const typingMessageId =
    typeof options.messageId === "string" ? options.messageId : null;

  if (!session.pendingQuery) {
    await sendTextMessage(userId, "Please type what you would like to adjust before generating.");
    return true;
  }

  await sendTextMessage(userId, "🛠️ Generating your updated design. This should only take a moment...");

  try {
    await callAgentAPI(userId, session.pendingQuery, session.uploadedImages, {
      typingMessageId,
    });
  } finally {
    resetEditSession(userId);
  }

  return true;
}

async function sendEditSessionSummary(userId) {
  const session = userEditSessions[userId];
  if (!session) return;

  touchEditSession(userId);

  const totalImageCount = session.uploadedImages.length;
  const userImageCount = getUserUploadedImageCount(session);
  const hasUserImages = userImageCount >= 1;
  const summaryLines = [];

  if (userImageCount > 0) {
    summaryLines.push(
      `Images saved: ${userImageCount}${
        session.uploadedImages.some((img) => img.isPrimary)
          ? " (excluding the pinned inspiration)"
          : ""
      }`
    );
  } else {
    summaryLines.push("No reference images yet.");
  }

  if (session.pendingQuery) {
    summaryLines.push(`Request:\n${session.pendingQuery}`);
  } else if (hasUserImages) {
    summaryLines.push("Type your updated request to continue.");
  } else {
    summaryLines.push("Share what you'd like to change or add inspiration photos to guide the update.");
  }

  session.actions = {
    edit_generate: "generate",
    edit_cancel: "cancel",
  };

  const primaryImage =
    session.uploadedImages.find((img) => img.isPrimary) ||
    session.uploadedImages[0] ||
    null;
  let mediaId = null;
  let headerText = null;

  if (primaryImage) {
    if (primaryImage.whatsAppMediaId) {
      mediaId = primaryImage.whatsAppMediaId;
    } else if (primaryImage.uploadedUrl) {
      try {
        mediaId = await uploadImageToWhatsApp(primaryImage.uploadedUrl);
        primaryImage.whatsAppMediaId = mediaId;
        console.log("📤 Mirrored header image to WhatsApp. Media ID:", mediaId);
      } catch (uploadErr) {
        console.error(
          "⚠️ Failed to mirror header image to WhatsApp:",
          uploadErr.response?.data || uploadErr.message
        );
      }
    }

    if (!mediaId && primaryImage.mediaId) {
      mediaId = primaryImage.mediaId;
    }
  }

  if (!mediaId && session.pendingQuery) {
    headerText = session.pendingQuery;
  }

  if (session.pendingQuery) {
    const prompt = `${summaryLines.join("\n\n")}\n\nReady to generate the update?`;

    await sendInteractiveButtonMessage(
      userId,
      prompt,
      [
        { id: "edit_generate", title: "Generate" },
        { id: "edit_cancel", title: "Cancel" },
      ],
      mediaId,
      headerText
    );

    console.log("📤 Sent edit summary with header:", {
      userId,
      mediaId,
      headerText,
      hasPendingQuery: true,
      totalImageCount,
      userImageCount,
      hasUserImages,
    });
  } else {
    await sendTextMessage(userId, summaryLines.join("\n\n"));

    console.log("ℹ️ Prompted user for edit request:", {
      userId,
      hasPendingQuery: Boolean(session.pendingQuery),
      totalImageCount,
      userImageCount,
      hasUserImages,
    });
  }
}



//Reuse Tokens from .env
const {
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  AUTHORIZE_TOKEN,
  AGENT_START_ENDPOINT: ENV_AGENT_START_ENDPOINT,
  AGENT_SUBDOMAIN = "construex",
  AGENT_USER_TYPE = "customer",
} = process.env;

const AGENT_START_ENDPOINT =
  ENV_AGENT_START_ENDPOINT ||
  "https://api.gettaskagent.com/api/user/agent/start/691029772222bd196b5c8f41";

const EDIT_AGENT_START_ENDPOINT =
  process.env.EDIT_AGENT_START_ENDPOINT ||
  "https://api.gettaskagent.com/api/user/agent/start/690f135b40eebb79503aa541";

const FILE_UPLOAD_ENDPOINT =
  process.env.FILE_UPLOAD_ENDPOINT || "https://api.gettaskagent.com/api/file/upload";

const INSPIRATION_SEARCH_ENDPOINT =
  process.env.INSPIRATION_SEARCH_ENDPOINT ||
  "https://api.abyat.com/inspirations/search";

const DEFAULT_FACET_SEQUENCE = [
  "rooms",
  "colors",
  "styles",
  "lightingAndAtmospheres",
  "prices",
];

const ROOM_DYNAMIC_FILTER_KEYS = {
  LIVING_ROOM: ["livingRoomLayout", "livingRoomSpace"],
  DINING_ROOM: ["diningRoomType", "diningRoomTableSize"],
  BEDROOM: ["bedroomType", "bedroomBedSize"],
  OUTDOOR: ["outdoorFeature", "outdoorSpace"],
};

const ALL_DYNAMIC_FILTER_KEYS = Array.from(
  new Set(Object.values(ROOM_DYNAMIC_FILTER_KEYS).flat())
);

const ROOM_FACET_SEQUENCE = {
  LIVING_ROOM: [
    "rooms",
    "colors",
    "styles",
    "lightingAndAtmospheres",
    "livingRoomLayout",
    "livingRoomSpace",
    "prices",
  ],
  DINING_ROOM: [
    "rooms",
    "colors",
    "styles",
    "lightingAndAtmospheres",
    "diningRoomType",
    "diningRoomTableSize",
    "prices",
  ],
  BEDROOM: [
    "rooms",
    "colors",
    "styles",
    "lightingAndAtmospheres",
    "bedroomType",
    "bedroomBedSize",
    "prices",
  ],
  OUTDOOR: [
    "rooms",
    "colors",
    "styles",
    "lightingAndAtmospheres",
    "outdoorFeature",
    "outdoorSpace",
    "prices",
  ],
};

const FILTER_KEY_TO_FACET = {
  rooms: "ROOM",
  colors: "COLORS",
  styles: "STYLES",
  lightingAndAtmospheres: "LIGHTING_ATMOSPHERE",
  livingRoomLayout: "LIVING_ROOM_LAYOUT",
  livingRoomSpace: "LIVING_ROOM_SPACE",
  diningRoomType: "DINING_ROOM_TYPE",
  diningRoomTableSize: "DINING_ROOM_TABLE_SIZE",
  bedroomType: "BEDROOM_TYPE",
  bedroomBedSize: "BEDROOM_BED_SIZE",
  outdoorSpace: "OUTDOOR_SPACE",
  outdoorFeature: "OUTDOOR_FEATURE",
  prices: "PRICE",
};

const FACET_LABELS = {
  rooms: "a room type",
  colors: "a color palette",
  styles: "a style",
  lightingAndAtmospheres: "lighting & atmosphere",
  livingRoomLayout: "a living room layout",
  livingRoomSpace: "a living room space",
  diningRoomType: "a dining room type",
  diningRoomTableSize: "a dining room table size",
  bedroomType: "a bedroom type",
  bedroomBedSize: "a bed size",
  outdoorSpace: "an outdoor space",
  outdoorFeature: "an outdoor feature",
  prices: "a price range",
};

const PRICE_PROMPT_TEXT =
  "Reply with your budget range in SAR (example: 2000-5000). You can also type *skip* if you want to move on without setting a price.";
const PRICE_SINGLE_VALUE_TEXT =
  "I saw one price value. Please include both a minimum and a maximum like 2000-5000 so I can filter properly.";
const RESPONSE_FOOTER_TEXT = "Type *3* anytime to restart your design preferences.";

function appendFooterText(message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    return RESPONSE_FOOTER_TEXT;
  }

  const normalized = text.toLowerCase();
  if (
    normalized.includes("type *3*") ||
    normalized.includes("type 3") ||
    normalized.includes(RESPONSE_FOOTER_TEXT.toLowerCase())
  ) {
    return text;
  }

  return `${text}\n\n${RESPONSE_FOOTER_TEXT}`;
}

function generateSessionId() {
  try {
    return `sess_${randomUUID()}`;
  } catch (err) {
    return `sess_${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
}

function sequenceToFacetTokens(sequence = []) {
  return sequence
    .map((key) => FILTER_KEY_TO_FACET[key] || String(key || "").toUpperCase())
    .filter(Boolean);
}

function getFacetSequence(state = {}) {
  const room = state?.filters?.rooms?.[0];
  return ROOM_FACET_SEQUENCE[room] || DEFAULT_FACET_SEQUENCE;
}

function humanizeFacetKey(key) {
  if (!key) return "";
  return String(key)
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function facetLabel(key) {
  return FACET_LABELS[key] || humanizeFacetKey(key);
}

function truncate(value, maxLength = 24) {
  if (typeof value !== "string") return value;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function needsSelection(filters = {}, key) {
  if (!key) return false;
  if (key === "prices") {
    const prices = filters.prices || {};
    if (prices.skipped) return false;
    const hasMin = typeof prices.min === "number";
    const hasMax = typeof prices.max === "number";
    return !hasMin && !hasMax;
  }
  const value = filters[key];
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return true;
}

function createInitialDesignState() {
  return {
    locale: "en-US",
    currency: "SAR",
    marketplace: "SA",
    seed: "b7bae4da-de63-4620-af62-61c380c69248",
    size: 1,
    page: 1,
    filters: {
      rooms: [],
      colors: [],
      styles: [],
      lightingAndAtmospheres: [],
      prices: {},
    },
    currentFacets: sequenceToFacetTokens(DEFAULT_FACET_SEQUENCE),
  };
}

function ensureDesignState(state) {
  if (!state || typeof state !== "object") {
    return createInitialDesignState();
  }

  const base = createInitialDesignState();
  const merged = {
    ...base,
    ...state,
    filters: {
      ...base.filters,
      ...(state.filters || {}),
    },
  };

  if (!merged.filters.prices || typeof merged.filters.prices !== "object") {
    merged.filters.prices = {};
  }

  merged.currentFacets = sequenceToFacetTokens(getFacetSequence(merged));
  return merged;
}

function applySelectionToState(state, filterKey, rawValue) {
  if (!filterKey) return ensureDesignState(state);

  const nextState = ensureDesignState(state);
  const nextFilters = { ...nextState.filters };

  if (filterKey === "rooms") {
    const roomValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    nextFilters.rooms = roomValue ? [roomValue] : [];

    ALL_DYNAMIC_FILTER_KEYS.forEach((key) => {
      delete nextFilters[key];
    });

    const dynamicKeys = ROOM_DYNAMIC_FILTER_KEYS[roomValue] || [];
    dynamicKeys.forEach((key) => {
      if (!Array.isArray(nextFilters[key])) {
        nextFilters[key] = [];
      }
    });
  } else if (filterKey === "prices") {
    if (typeof rawValue === "string" && rawValue.trim().toLowerCase() === "skip") {
      nextFilters.prices = { skipped: true };
    } else if (rawValue && typeof rawValue === "object") {
      if (rawValue.skip || rawValue.skipped) {
        nextFilters.prices = { skipped: true };
      } else {
        const { min, max } = rawValue;
        nextFilters.prices = {
          min: typeof min === "number" ? min : undefined,
          max: typeof max === "number" ? max : undefined,
        };
      }
    } else if (typeof rawValue === "string" && rawValue.includes("-")) {
      const [minStr, maxStr] = rawValue.split("-");
      const min = Number(minStr);
      const max = Number(maxStr);
      nextFilters.prices = {
        min: Number.isFinite(min) ? min : undefined,
        max: Number.isFinite(max) ? max : undefined,
      };
    } else {
      nextFilters.prices = nextFilters.prices || {};
    }
  } else {
    const normalized = Array.isArray(rawValue)
      ? rawValue.filter(Boolean)
      : rawValue
      ? [rawValue]
      : [];
    nextFilters[filterKey] = normalized;
  }

  nextState.filters = nextFilters;
  nextState.currentFacets = sequenceToFacetTokens(getFacetSequence(nextState));
  return nextState;
}

function determineNextFacetKey(state, previousKey) {
  const sequence = getFacetSequence(state);
  let startIndex = 0;

  if (previousKey) {
    const previousIndex = sequence.indexOf(previousKey);
    startIndex = previousIndex >= 0 ? previousIndex + 1 : 0;
  }

  for (let index = startIndex; index < sequence.length; index += 1) {
    const candidate = sequence[index];
    if (needsSelection(state.filters, candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildSummaryMessage(designResponse, { isReset = false, nextFacetKey } = {}) {
  const inspirations = Array.isArray(designResponse?.inspirations)
    ? designResponse.inspirations
    : Array.isArray(designResponse?.results)
    ? designResponse.results
    : [];

  const total =
    typeof designResponse?.total === "number"
      ? designResponse.total
      : inspirations.length;

 const lines = [];

if (isReset) {
  lines.push("👋 Welcome to your AI Home Designer!");
}

if (total > 0) {
  lines.push("✨ ABYAT Imagine is curating stunning design inspirations just for you...");
} else {
  lines.push("💡 Let’s discover beautiful room inspirations crafted around your unique style and preferences.");
}


  if (nextFacetKey) {
    if (nextFacetKey === "prices") {
      lines.push(
        "\n\nTell me your budget range so I can narrow the inspirations to fit your needs."
      );
    } else {
     lines.push(`\n\nPlease select your preferred ${facetLabel(nextFacetKey)} to proceed.`);
    }
  } else {
    lines.push(
      "\n\nThese preferences look great! Please wait while we are preparing your design options."
    );
  }

  return lines.join("\n");
}

function sanitizeOptionsForWhatsApp(options = []) {
  return options.map((option, index) => {
    const fallbackId = `option_${index + 1}`;
    const canonicalId =
      option.value ||
      option.id ||
      (option.title &&
        option.title.replace(/\s*\(\d+\)$/, "").toUpperCase().replace(/\s+/g, "_")) ||
      fallbackId;

    const rawTitle =
      option.label ||
      (typeof option.title === "string"
        ? option.title.replace(/\s*\(\s*\d+(\.\d+)?\s*\)\s*$/g, "")
        : option.title) ||
      option.value ||
      canonicalId;

    const formattedTitle = truncate(toTitleCase(rawTitle), 24);
    const description =
      typeof option.count === "number"
        ? `Count: ${option.count.toLocaleString()}`
        : option.description || "";

    return {
      ...option,
      id: option.id || canonicalId,
      value: canonicalId,
      title: formattedTitle,
      description: truncate(description, 60),
    };
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
}

function formatCurrency(amount, currency = "SAR", locale = "en-SA") {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch (err) {
    return `${currency} ${numeric.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
}

function createPreviewFromDesignResponse(designResponse) {
    console.log('CREATE PREVIEW FROM DESIGN RESPONSE');
    console.log('DESIGN RESPONSE:', designResponse);
    
  if (!designResponse || typeof designResponse !== "object") return null;

  const inspirations = Array.isArray(designResponse?.inspirations)
    ? designResponse.inspirations
    : Array.isArray(designResponse?.results)
    ? designResponse.results
    : null;

  if (!inspirations || inspirations.length === 0) {
    return null;
  }

  const total =
    typeof designResponse.total === "number"
      ? designResponse.total
      : typeof designResponse.totalHits === "number"
      ? designResponse.totalHits
      : inspirations.length;

  return {
    inspirations,
    total,
    facetCounts: designResponse.facetCounts,
  };
}

function derivePreferredBudget(designResponse, designState) {
  const priceFacet = designResponse?.facetCounts?.prices;
  if (priceFacet) {
    if (typeof priceFacet.max === "number") {
      return priceFacet.max;
    }
    if (Array.isArray(priceFacet.ranges)) {
      const maxRange = priceFacet.ranges
        .map((range) => (typeof range?.max === "number" ? range.max : undefined))
        .filter((value) => Number.isFinite(value));
      if (maxRange.length > 0) {
        return Math.max(...maxRange);
      }
    }
    if (Array.isArray(priceFacet.segments)) {
      const segments = priceFacet.segments.filter((value) => Number.isFinite(value));
      if (segments.length > 0) {
        return Math.max(...segments);
      }
    }
  }

  const stateBudget = designState?.filters?.prices?.max;
  return Number.isFinite(stateBudget) ? stateBudget : null;
}

async function fetchInspirationPreview(designState) {
  try {
    console.log("🛰️ Fetching inspiration preview from API");
    const previewState = {
      ...designState,
      size: MIN_INSPIRATION_PREVIEW_COUNT,
      page: 1,
    };

    const formData = new FormData();
    const payload = buildDesignSearchPayload(previewState);
    formData.append("query", JSON.stringify(payload));

    const agentRes = await axios.post(AGENT_START_ENDPOINT, formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
        subdomain: AGENT_SUBDOMAIN,
        "x-user-type": AGENT_USER_TYPE,
      },
    });
    const agentData = agentRes?.data;
        console.log('AGENT DATA:', agentData);
        
        const extractedDesign = extractDesignResponseFromAgent(agentData);
        console.log('EXTRACTED DESIGN:', extractedDesign);
        return extractedDesign;
  } catch (err) {
    console.error("⚠️ fetchInspirationPreview error:", err.response?.data || err.message);
  }
  return null;
}

async function ensureInspirationPreview(
  to,
  designState,
  designResponse,
  { forceRefresh = false } = {}
) {
  console.log("ENSURE INSPIRATION PREVIEW");
  const existing = userInspirationContext[to];
  const existingCount = existing?.preview?.inspirations?.length || 0;
  const hasSufficientExisting = existingCount >= MIN_INSPIRATION_PREVIEW_COUNT;

  if (!forceRefresh && hasSufficientExisting) {
    console.log("✅ Using cached inspiration preview");
    existing.actions = existing.actions || {};
    return existing.preview;
  }

  if (!forceRefresh && existing?.error && !hasSufficientExisting) {
    const elapsed = Date.now() - (existing.timestamp || 0);
    if (elapsed < INSPIRATION_PREVIEW_RETRY_MS) {
      console.log("⏳ Skipping preview fetch - last attempt failed recently");
      return null;
    }
    console.log("🔁 Retrying inspiration preview fetch after previous error");
  }

  const fromDesign = createPreviewFromDesignResponse(designResponse);
  const designCount = fromDesign?.inspirations?.length || 0;
  const designHasEnough = designCount >= MIN_INSPIRATION_PREVIEW_COUNT;

  if (!forceRefresh && designHasEnough) {
    console.log("📦 Using inspirations from design response");
    userInspirationContext[to] = {
      preview: fromDesign,
      timestamp: Date.now(),
      actions: {},
    };
    return fromDesign;
  }

  console.log("🌐 Attempting to fetch inspirations preview via API");
  let preview = await fetchInspirationPreview(designState);
  console.log('PREVIEW:', preview);
  

  if (!preview?.inspirations?.length && fromDesign?.inspirations?.length) {
    console.log("⚠️ Preview fetch empty, falling back to design response data");
    preview = fromDesign;
  }

  if (preview?.inspirations?.length) {
    console.log("✅ Inspiration preview available");
    userInspirationContext[to] = {
      preview,
      timestamp: Date.now(),
      actions: {},
    };

    console.log('USER INSPIRATION CONTEXT:', userInspirationContext);
    
    return preview;
  }

  userInspirationContext[to] = {
    preview: null,
    error: true,
    timestamp: Date.now(),
    actions: {},
  };

  return null;
}

async function sendInspirationPreviewOptions(
    to,
    responseText,
    designState,
    designResponse,
    { forceRefresh = false } = {}
  ) {
    const preview = await ensureInspirationPreview(to, designState, designResponse, {
      forceRefresh,
    });
    if (!preview || !Array.isArray(preview.inspirations) || preview.inspirations.length === 0) {
      return false;
    }
  
    const context =
      userInspirationContext[to] ||
      (userInspirationContext[to] = { preview, timestamp: Date.now(), actions: {} });
    context.preview = preview;
    context.actions = {};
  
    if (responseText) {
      await sendTextMessage(to, responseText);
    }
  
    const inspirations = preview.inspirations.slice(0, 4);
  
    for (let index = 0; index < inspirations.length; index += 1) {
      const inspiration = inspirations[index];
      const imageUrl = getInspirationImageUrl(inspiration);
      const title =
        typeof inspiration?.room === "string" && inspiration.room
          ? toTitleCase(inspiration.room)
          : `Inspiration ${index + 1}`;
      const description =
        truncate(inspiration?.description || "", 260) ||
        "Curated inspiration just for you. Let me know if you’d like to adjust anything.";

           const interactionOptions = [
        { id: `edit_preferences_${index + 1}`, title: "Edit Preferences" },
      ];
  
   context.actions[interactionOptions[0].id] = { action: "edit_preferences", index };
  
      userFacetContext[to] = {
        facetKey: null,
        options: interactionOptions,
        timestamp: Date.now(),
        preview: true,
      };
      if (imageUrl) {
        try {
          const mediaId = await uploadImageToWhatsApp(imageUrl);
          console.log('MEDIA-ID:',mediaId);
          // await sendImageReply(to, mediaId, title, description);
          
          // await sendImageReply(to, mediaId, title, description);
          await sendInteractiveButtonMessage(
      to,
      `🖼️ *${title}*\n${description}`,
      interactionOptions.map(({ id, title }) => ({ id, title })),
      mediaId
    );
        } catch (err) {
          console.error("⚠️ Unable to send inspiration image:", err.message);
          await sendTextMessage(to, `${title}: ${description}`);
        }
      } else {
        await sendTextMessage(to, `${title}: ${description}`);
      }
  
      // const interactionOptions = [
      //   { id: `edit_preferences_${index + 1}`, title: "Edit Preferences" },
      // ];
  
      // context.actions[interactionOptions[0].id] = { action: "edit_preferences", index };
  
      // userFacetContext[to] = {
      //   facetKey: null,
      //   options: interactionOptions,
      //   timestamp: Date.now(),
      //   preview: true,
      // };
  
      // await sendButtonMessage(
      //   to,
      //   `What would you like to do with Inspiration ${index + 1}?`,
      //   interactionOptions.map(({ id, title }) => ({ id, title }))
      // );
  
      if (index < inspirations.length - 1) {
        await delay(600);
      }
    }
  
    // const finalOptions = [
    //   { id: "regenerate_inspirations", title: "Regenerate" },
    // ];
  
    // context.actions.regenerate_inspirations = { action: "regenerate_inspirations" };
  
    // userFacetContext[to] = {
    //   facetKey: null,
    //   options: finalOptions,
    //   timestamp: Date.now(),
    //   preview: true,
    // };
  
    // await sendButtonMessage(
    //   to,
    //   "Would you like another set of inspirations or adjust your preferences?",
    //   finalOptions.map(({ id, title }) => ({ id, title })),
    //   undefined,
    //   { includeFooter: false }
    // );
  
    return true;
  }
  

async function handleInspirationAction(
  to,
  designState,
  action,
  designResponse,
  actionMeta = {}
) {
  const normalized = String(action || "").toLowerCase();
  const preview = await ensureInspirationPreview(to, designState, designResponse, {
    forceRefresh: normalized === "regenerate_inspirations",
  });

  if (!preview || !Array.isArray(preview.inspirations) || preview.inspirations.length === 0) {
    await sendTextMessage(
      to,
      "I couldn't load your inspirations right now. Please try again in a moment or adjust your preferences."
    );
    return;
  }

  const inspirations = preview.inspirations.slice(0, MIN_INSPIRATION_PREVIEW_COUNT);

  if (normalized === "view_inspirations" || normalized === "generate_inspirations") {
    await sendInspirationPreviewOptions(
      to,
      normalized === "generate_inspirations"
        ? "Here are inspirations tailored to your preferences."
        : "Here are your inspirations again.",
      designState,
      designResponse,
      { forceRefresh: normalized === "generate_inspirations" }
    );
    return;
  }

  if (normalized === "regenerate_inspirations") {
    const refreshed = await sendInspirationPreviewOptions(
      to,
      "Here’s another set of inspirations for you.",
      designState,
      designResponse,
      { forceRefresh: true }
    );

    if (!refreshed) {
      await sendTextMessage(
        to,
        "I wasn’t able to regenerate new inspirations right now. Please try again shortly."
      );
    }
    return;
  }

  if (normalized === "view_products") {
    const index = Math.max(
      0,
      Math.min(
        inspirations.length - 1,
        Number.isFinite(actionMeta?.index) ? actionMeta.index : 0
      )
    );
    const target = inspirations[index];
    const productIds = extractProductIdsFromInspiration(target).slice(0, 5);

    if (productIds.length === 0) {
      await sendTextMessage(
        to,
        "I couldn’t find specific product matches in this inspiration, but I can fetch more ideas if you tweak your preferences."
      );
    } else {
      const productLines = productIds
        .map((productId, idx) => `${idx + 1}. Product ID: ${productId}`)
        .join("\n");

      await sendTextMessage(
        to,
        `Here are some key products from Inspiration ${index + 1}:\n${productLines}\n\nLet me know if you'd like details on any of these.`
      );
    }

    const followUpOptions = [
      { id: "regenerate_inspirations", title: "Regenerate" },
      { id: "edit_preferences_summary", title: "Edit Preferences" },
    ];

    const context = userInspirationContext[to];
    if (context) {
      context.actions = context.actions || {};
      context.actions.regenerate_inspirations = { action: "regenerate_inspirations" };
      context.actions.edit_preferences_summary = { action: "edit_preferences" };
    }

    userFacetContext[to] = {
      facetKey: null,
      options: followUpOptions,
      timestamp: Date.now(),
      preview: true,
    };

    await sendButtonMessage(
      to,
      "What would you like to do next?",
      followUpOptions.map(({ id, title }) => ({ id, title })),
      undefined,
      { includeFooter: false }
    );
    return;
  }

  if (normalized === "edit_preferences") {
    const index = Math.max(
      0,
      Math.min(
        inspirations.length - 1,
        Number.isFinite(actionMeta?.index) ? actionMeta.index : 0
      )
    );

    const target = inspirations[index];
    const primaryImageUrl = getInspirationImageUrl(target);

    delete userInspirationContext[to];
    await startEditPreferenceSession(to, {
      primaryImageUrl,
      primaryCaption: target?.room ? toTitleCase(target.room) : null,
    });
    return;
  }
}

async function sendPreferredBudgetAndPreview(to, responseText, designState, designResponse) {
  console.log('SEND PREFERRED BUDGET AND PREVIEW');
  const preferredBudget = derivePreferredBudget(designResponse, designState);
  const formattedBudget = preferredBudget
    ? formatCurrency(preferredBudget, designState?.currency || "SAR")
    : null;

  const sanitizedSummary = responseText
    ? responseText
        .split("\n")
        .filter((line) => !/choose/i.test(line) || !/price/i.test(line))
        .join("\n")
    : "";

  const messageLines = ["💡 Preferred Budget"];

  if (formattedBudget) {
    messageLines.push(
      `Based on your selections, we recommend a budget of ${formattedBudget}.`
    );
  } else {
    messageLines.push(
      "Based on your selections, we recommend continuing with these inspirations."
    );
  }

  messageLines.push(
    "Budget adjustments aren’t available right now, but you can proceed with this tailored recommendation."
  );

  const composedMessage = [sanitizedSummary, messageLines.join("\n")]
    .filter((segment) => segment && segment.trim().length > 0)
    .join("\n\n");

  await sendTextMessage(to, composedMessage);

  console.log('SEND INSPIRATION PREVIEW OPTIONS 🚀 BEFORE');

  const previewSent = await sendInspirationPreviewOptions(
    to,
    "Here are inspirations tailored to your preferences.",
    designState,
    designResponse
  );

  if (previewSent) {
    return true;
  }

  const fallbackOptions = [
    { id: "view_inspirations", title: "View Inspirations", value: "view_inspirations" },
    { id: "edit_preferences", title: "Edit Preferences", value: "edit_preferences" },
  ];

  userFacetContext[to] = {
    facetKey: null,
    options: fallbackOptions,
    timestamp: Date.now(),
    preview: true,
  };

  await sendButtonMessage(
    to,
    "Would you like to view the inspirations or adjust your preferences?",
    fallbackOptions.map(({ id, title }) => ({ id, title })),
    undefined,
    { includeFooter: false }
  );

  return true;
}

function parsePriceTokens(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const tokens = [];
  const regex = /(\d+(?:[.,]\d+)?)(\s*[kKmM]?)/g;
  let match;

  while ((match = regex.exec(text))) {
    const rawNumber = match[1];
    const suffix = (match[2] || "").trim().toLowerCase();
    let value = Number(rawNumber.replace(/,/g, ""));

    if (!Number.isFinite(value)) continue;

    if (suffix === "k") {
      value *= 1_000;
    } else if (suffix === "m") {
      value *= 1_000_000;
    }

    tokens.push(value);
  }

  return tokens;
}

function parsePriceInput(text) {
  const tokens = parsePriceTokens(text);

  if (tokens.length >= 2) {
    const [first, second] = tokens;
    const min = Math.min(first, second);
    const max = Math.max(first, second);

    if (min === max) {
      return { selection: null, error: "singleValue", value: min };
    }

    return {
      selection: { min, max },
      error: null,
      value: { min, max },
    };
  }

  if (tokens.length === 1) {
    return { selection: null, error: "singleValue", value: tokens[0] };
  }

  return { selection: null, error: null, value: null };
}

function formatPriceRangeForMessage({ min, max }) {
  const formatter = new Intl.NumberFormat("en-SA", {
    style: "currency",
    currency: "SAR",
    maximumFractionDigits: 0,
  });

  const formattedMin = Number.isFinite(min) ? formatter.format(min) : null;
  const formattedMax = Number.isFinite(max) ? formatter.format(max) : null;

  if (formattedMin && formattedMax) {
    return `${formattedMin} - ${formattedMax}`;
  }

  if (formattedMin) return `from ${formattedMin}`;
  if (formattedMax) return `up to ${formattedMax}`;

  return null;
}


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
      const text = msg?.text?.body?.trim();
      await sessionResponseAPI(from, text || "", {
        messageType: "text",
        messageId: msgId,
      });
    } else if (msg.type === "interactive") {
      const buttonReply = msg?.interactive?.button_reply;
      const listReply = msg?.interactive?.list_reply;
      const selection = buttonReply || listReply;
      const title = selection?.title?.trim() || "";

      console.log(`🟢 Selection received: ${title}`);

      const editHandled =
        (selection?.id &&
          (await handleEditSessionAction(from, selection.id, { messageId: msgId }))) ||
        (title &&
          (await handleEditSessionAction(from, title, { messageId: msgId })));
      if (editHandled) {
        return;
      }

      let facetMeta = userFacetContext[from];

      if (!facetMeta) {
        const fallbackFacetKey = userSteps[from];
        if (fallbackFacetKey) {
          const fallbackOptions = sanitizeOptionsForWhatsApp(
            extractFacetOptions(userFacets[from], fallbackFacetKey, {
              limit: 10,
            })
          );

          facetMeta = {
            facetKey: fallbackFacetKey,
            options: fallbackOptions,
            timestamp: Date.now(),
            recovered: true,
          };

          userFacetContext[from] = facetMeta;
          console.warn(
            `♻️ Rebuilt facet context for ${from} (${fallbackFacetKey})`
          );
        }
      }

      console.log("FACET META:", facetMeta);

      const inspirationActions = userInspirationContext[from]?.actions || {};

      const matchedOption =
        facetMeta?.options?.find((opt) => {
          const normalizedTitle = title?.toUpperCase();
          const normalizedOptTitle = opt.title?.toUpperCase();
          return (
            opt.id === selection?.id ||
            opt.title === title ||
            opt.value === title ||
            (normalizedTitle && normalizedOptTitle === normalizedTitle)
          );
        }) || null;

      const initialResolved =
        matchedOption?.value ??
        matchedOption?.id ??
        selection?.id ??
        title;

      const actionMapping =
        inspirationActions[selection?.id] || inspirationActions[initialResolved] || null;

      const resolvedValue = actionMapping?.action || initialResolved;
      const resolvedFacetKey =
        actionMapping || !facetMeta ? null : facetMeta?.facetKey ?? userSteps[from] ?? null;
      const inspirationIndex =
        actionMapping && typeof actionMapping.index === "number"
          ? actionMapping.index
          : undefined;

      const meta = {
        messageType: buttonReply ? "button" : "list",
        selectionId: selection?.id,
        selectionTitle: title,
        selectionValue: resolvedValue,
        selectionCount: matchedOption?.count,
        facetKey: resolvedFacetKey,
        facetValue: resolvedValue,
        designSearchState: userDesignStates[from],
        facetCounts: userFacets[from],
        inspirationIndex,
        designAction: actionMapping?.action || null,
        designActionMeta: actionMapping || null,
      };

      console.log('META:', meta);

      await sessionResponseAPI(
        from,
        title || resolvedValue || "",
        Object.assign(meta, { messageId: msgId })
      );

      if (facetMeta) {
        delete userFacetContext[from];
      }
    }  else if (msg.type === "image") {
      const editSession = userEditSessions[from];
      if (!editSession) {
        await sendTextMessage(
          from,
          "Tap *Edit Preferences* before sending photos so I can use them in your update."
        );
        return;
      }

      const imageData = msg.image;
      const caption = imageData?.caption || "(no caption)";
      const imageId = imageData?.id;

      console.log(`🖼️ Received image from ${from}`);
      console.log(`📄 Caption: ${caption}`);
      console.log(`🪪 Media ID: ${imageId}`);

      const imageUrl = await getMediaUrl(imageId);
      console.log("✅ Fetched image URL:", imageUrl);

      const { buffer, mimeType, fileExt } = await downloadMediaBuffer(imageUrl);
      console.log("📥 Downloaded image buffer:", buffer.length, "bytes");

      const uploadResult = await uploadToExternalAPI(
        buffer,
        `${imageId}.${fileExt}`,
        mimeType
      );
      console.log("🌐 Uploaded URLs:", uploadResult.uploadedUrls);

      let whatsAppMediaId = null;
      const uploadSourceUrl = uploadResult.uploadedUrls?.[0] || imageUrl;

      if (uploadSourceUrl) {
        try {
          whatsAppMediaId = await uploadImageToWhatsApp(uploadSourceUrl);
          console.log("📤 Re-uploaded image to WhatsApp. Media ID:", whatsAppMediaId);
        } catch (uploadErr) {
          console.error(
            "⚠️ Failed to upload image to WhatsApp for interactive header:",
            uploadErr.response?.data || uploadErr.message
          );
        }
      } else {
        console.warn("⚠️ No upload URL available to mirror image on WhatsApp.");
      }

      if (!whatsAppMediaId && imageId) {
        console.log(
          "ℹ️ Falling back to original inbound media id for interactive header."
        );
        whatsAppMediaId = imageId;
      }

      editSession.uploadedImages.push({
        buffer: uploadResult.buffer,
        mimeType: uploadResult.mimeType,
        filename: uploadResult.filename,
        uploadedUrl: uploadResult.uploadedUrls?.[0] || null,
        sourceUrl: imageUrl,
        mediaId: imageId,
        whatsAppMediaId,
        caption,
      });

      touchEditSession(from);

      const userImageCount = getUserUploadedImageCount(editSession);
      const encouragementLines = ["✅ Photo added to your edit board."];

      if (userImageCount > 1) {
        encouragementLines.push(`You now have ${userImageCount} inspiration photos ready.`);
      } else {
        encouragementLines.push("This image is now ready for your update.");
      }

      encouragementLines.push(
        "Send more photos, describe what to change, or type *7* to wrap up edit mode."
      );
      await sendTextMessage(from, encouragementLines.join("\n\n"));

      if (editSession.pendingQuery) {
        await sendEditSessionSummary(from);
      }

      return;
    } else {
      const placeholderText =
        (msg.type === "voice" && "[voice message]") ||
        (msg.type === "image" && "[image]") ||
        (msg.type === "audio" && "[audio]") ||
        (msg.type === "video" && "[video]") ||
        (msg.type === "document" && "[document]") ||
        "[unsupported message]";

      await sessionResponseAPI(from, placeholderText, {
        messageType: msg.type || "text",
        messageId: msgId,
      });
    }

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    // await sendFallbackMessage(from);
  }
});

async function sessionResponseAPI(to, query, meta = {}) {
  const typingMessageId =
    typeof meta.messageId === "string" && meta.messageId.trim().length > 0
      ? meta.messageId
      : null;

      // console.log('TYPING:',typingMessageId);
      

  try {
    if (typingMessageId) {
      await sendTypingIndicator(to, typingMessageId, true);
    }

    resetSessionTimeout(to);

    console.log("🧠 Incoming query:", query);

    const trimmedQuery = typeof query === "string" ? query.trim() : "";
    const lowercaseQuery = trimmedQuery.toLowerCase();

    if (meta.messageType === "text" && userEditSessions[to]) {
      const handled = await handleEditSessionText(to, trimmedQuery, {
        messageId: typingMessageId,
      });
      if (handled) {
        return;
      }
    }

    const isFreshSession = !userSessions[to];
    const isResetCommand = lowercaseQuery === "1";
    const isRestartCommand = lowercaseQuery === "3";
    const shouldResetSession = isFreshSession || isResetCommand || isRestartCommand;

    if (shouldResetSession) {
      if (isRestartCommand) {
        console.log(`🔄 Restart command received from ${to}`);
      }
      resetUserState(to);
    }

    const pendingFacetKey = shouldResetSession ? null : userSteps[to] || null;

    let designState = ensureDesignState(userDesignStates[to]);

    const { messageType = "text" } = meta;
    let { facetKey, selectionValue } = meta;
    const designAction = !facetKey ? meta.designAction : null;
    const designActionMeta = !facetKey ? meta.designActionMeta : null;

    if (designAction === "final_design_accept") {
      resetEditSession(to);
      delete userInspirationContext[to];
      await sendTextMessage(
        to,
        "✅ Glad you like the design! Thanks for using AI Home Designer.\n\nType 1 anytime if you want to start a new project."
      );
      return;
    }

    if (designAction === "restart_edit_session") {
      delete userInspirationContext[to];
      await startEditPreferenceSession(to, {
        primaryImageUrl: designActionMeta?.primaryImageUrl || null,
        primaryCaption: designActionMeta?.primaryCaption || null,
        primaryImageMediaId: designActionMeta?.primaryImageMediaId || null,
        primaryImageWhatsAppId: designActionMeta?.primaryImageWhatsAppId || null,
      });
      return;
    }

    if (designAction === "start_edit_preferences") {
      delete userInspirationContext[to];
      await startEditPreferenceSession(to, {
        primaryImageUrl: designActionMeta?.primaryImageUrl || null,
        primaryCaption: designActionMeta?.primaryCaption || null,
        primaryImageMediaId: designActionMeta?.primaryImageMediaId || null,
        primaryImageWhatsAppId: designActionMeta?.primaryImageWhatsAppId || null,
      });
      return;
    }

    if (
      !facetKey &&
      typeof selectionValue === "string" &&
      [
        "generate_inspirations",
        "view_inspirations",
        "view_products",
        "edit_preferences",
        "regenerate_inspirations",
      ].includes(selectionValue.toLowerCase())
    ) {
      console.log('HANDLE INSPIRATION ACTION');
      await handleInspirationAction(to, designState, selectionValue, null, {
        index: typeof meta.inspirationIndex === "number" ? meta.inspirationIndex : undefined,
      });
      return;
    }

    if (!facetKey && pendingFacetKey === "prices" && trimmedQuery) {
      if (lowercaseQuery === "skip") {
        facetKey = "prices";
        selectionValue = { skipped: true };
        await sendTextMessage(
          to,
          "👍 Got it, I'll show inspirations from all price ranges."
        );
      } else {
        const parsed = parsePriceInput(trimmedQuery);

        if (parsed.selection) {
          facetKey = "prices";
          selectionValue = parsed.selection;

          const friendlyRange = formatPriceRangeForMessage(parsed.selection);
          if (friendlyRange) {
            await sendTextMessage(
              to,
              `💰 Budget set to ${friendlyRange}. Let me update your results.`
            );
          }
        } else if (parsed.error === "singleValue") {
          await sendTextMessage(to, `${PRICE_SINGLE_VALUE_TEXT}\n\n${PRICE_PROMPT_TEXT}`);
          return;
        }
      }
    }

    if (facetKey && selectionValue !== undefined) {
      designState = applySelectionToState(designState, facetKey, selectionValue);
      userDesignStates[to] = designState;
    } else {
      userDesignStates[to] = designState;
    }

    let nextFacetKey = determineNextFacetKey(
      designState,
      facetKey && selectionValue !== undefined ? facetKey : null
    );

    userSteps[to] = nextFacetKey;

    const agentPayload = createAgentQueryPayload({
      queryText: shouldResetSession ? "start" : trimmedQuery,
      messageType,
      sessionId: userSessions[to],
      currentStep: nextFacetKey,
      designSearchState: designState,
      selection:
        facetKey && selectionValue !== undefined
          ? { key: facetKey, value: selectionValue }
          : undefined,
      facetKey,
      facetValue: selectionValue,
      facets: userFacets[to],
    });

    // console.log(
    //   "🧠 Agent payload:",
    //   JSON.stringify(agentPayload, null, 2)
    // );
    let designResponse = null;
    let agentText = null;
    let designPreview = null;

    if (AUTHORIZE_TOKEN) {
      try {
        const formData = new FormData();
        const designPayload =
          agentPayload?.designSearchPayload ||
          buildDesignSearchPayload(designState);

        // console.log(
        //   "🧠 Design payload:",
        //   JSON.stringify(designPayload, null, 2)
        // );
        formData.append("query", JSON.stringify(designPayload));

        const agentRes = await axios.post(AGENT_START_ENDPOINT, formData, {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
            subdomain: AGENT_SUBDOMAIN,
            "x-user-type": AGENT_USER_TYPE,
          },
        });

        await sendTypingIndicator(to, typingMessageId, false);
        // console.log(
        //   "🧠 Agent response:",
        //   JSON.stringify(agentRes?.data, null, 2)
        // );

        const agentData = agentRes?.data;
        console.log('AGENT DATA:', agentData);
        
        const extractedDesign = extractDesignResponseFromAgent(agentData);
        console.log('EXTRACTED DESIGN:', extractedDesign);

        if (extractedDesign && typeof extractedDesign === "object") {
          const normalizedDesign = normalizeFacetCounts(extractedDesign);
          designResponse = normalizedDesign;
          console.log('DESIGN RESPONSE:', designResponse);
          console.log('NORMALIZED DESIGN:', normalizedDesign);
          if (
            normalizedDesign.facetCounts &&
            typeof normalizedDesign.facetCounts === "object"
          ) {
            userFacets[to] = normalizedDesign.facetCounts;
          }
        //   designPreview = createPreviewFromDesignResponse(normalizedDesign);
        //   if (designPreview) {
        //     userInspirationContext[to] = {
        //       preview: designPreview,
        //       timestamp: Date.now(),
        //       actions: {},
        //     };
        //   }
        }

        agentText = extractAgentSummaryText(agentData);
      } catch (agentError) {
        console.warn(
          "Agent workflow failed, continuing with summary:",
          agentError.message
        );
      }
    } else {
      console.warn("Missing AUTHORIZE_TOKEN, unable to query agent API.");
    }

    if (!designResponse) {
      designResponse = {
        facetCounts: userFacets[to] || {},
      };
    }

    if (!userFacets[to]) {
      userFacets[to] = designResponse.facetCounts || {};
    }

    const summaryText = buildSummaryMessage(designResponse, {
      isReset: shouldResetSession,
      nextFacetKey,
    });

    let responseText = summaryText;

    if (agentText) {
      responseText = agentText;
    }

    const visitedFacets = new Set();

    while (nextFacetKey) {
      if (visitedFacets.has(nextFacetKey)) {
        console.warn("⚠️ Detected facet loop, aborting:", nextFacetKey);
        nextFacetKey = null;
        break;
      }

      visitedFacets.add(nextFacetKey);

      const facetOptions = extractFacetOptions(userFacets[to], nextFacetKey, {
        limit: 10,
      });
      console.log(`FACET OPTIONS [${nextFacetKey}]:`, facetOptions);

      if (facetOptions.length > 0) {
        const options = sanitizeOptionsForWhatsApp(facetOptions);
        console.log("OPTIONS:", options);

        userFacetContext[to] = {
          facetKey: nextFacetKey,
          options,
          timestamp: Date.now(),
        };

        userSteps[to] = nextFacetKey;

        console.log("✅ Stored facet context:", userFacetContext[to]);

        const extraPrompt =
          nextFacetKey === "prices"
            ? `\n\nYou can also reply with your own range (e.g., 2000-5000).`
            : "";

        await sendListMessage(
          to,
          `${responseText}\n\nSelect from the options below to refine your design preferences.${extraPrompt}`,
          options
        );
        return;
      }

      if (nextFacetKey === "prices") {
        userSteps[to] = null;
        const handled = await sendPreferredBudgetAndPreview(
          to,
          responseText,
          designState,
          designPreview || designResponse
        );
        if (handled) {
          return;
        }
      }

      console.log(`♻️ Skipping facet ${nextFacetKey} due to empty results.`);
      nextFacetKey = determineNextFacetKey(designState, nextFacetKey);
    }

    if (!nextFacetKey) {
      console.log('SEND INSPIRATION PREVIEW OPTIONS 🚀');
      const previewSent = await sendInspirationPreviewOptions(
        to,
        responseText,
        designState,
        designPreview || designResponse
      );
      if (previewSent) {
        userSteps[to] = null;
        return;
      }
    }

    userSteps[to] = nextFacetKey || null;
    delete userFacetContext[to];

    await sendTextMessage(
      to,
      `${responseText}\n\nType *1* anytime - return to *main menu*.`
    );
  } catch (err) {
    console.error("❌ sessionResponseAPI error:", err.response?.data || err.message);
    await sendTextMessage(
      to,
      "⚠️ Something went wrong while generating your design. Please try again later."
    );
  } finally {
    if (typingMessageId) {
      try {
        await sendTypingIndicator(to, typingMessageId, false);
      } catch (typingErr) {
        console.warn(
          "⚠️ Typing indicator cleanup error:",
          typingErr.response?.data || typingErr.message
        );
      }
    }
  }
}



async function callAgentAPI(to, query, files = [], options = {}) {
  const typingMessageId =
    typeof options.typingMessageId === "string" ? options.typingMessageId : null;

  try {
    if (typingMessageId) {
      await sendTypingIndicator(to, typingMessageId, true);
    }

    const formData = new FormData();
    formData.append("query", query || "");

    if (Array.isArray(files) && files.length > 0) {
      const attachmentSummary = [];
      const seen = new Set();

      files.forEach((file, index) => {
        if (!file) return;

        const resolvedUrl = file.uploadedUrl || file.sourceUrl || null;
        const descriptor = {
          index,
          isPrimary: Boolean(file.isPrimary),
          uploadedUrl: file.uploadedUrl || null,
          sourceUrl: file.sourceUrl || null,
        };

        if (resolvedUrl) {
          if (!seen.has(resolvedUrl)) {
            formData.append("files[]", resolvedUrl);
            seen.add(resolvedUrl);
          }
        } else if (file.buffer && file.buffer.length) {
          const fallbackExt = mime.extension(file.mimeType || "") || "jpg";
          const fallbackName =
            file.filename ||
            `edit-${Date.now()}-${index + 1}.${fallbackExt}`;

          formData.append("files[]", file.buffer, {
            filename: fallbackName,
            contentType: file.mimeType || "application/octet-stream",
          });

          descriptor.uploadedUrl = `[buffer:${fallbackName}]`;
        } else {
          descriptor.warning = "no attachment data";
        }

        attachmentSummary.push(descriptor);
      });

      console.log("📦 Prepared edit attachments:", attachmentSummary);
    }

    console.log("🧾 FormData prepared for agent call:", {
      queryLength: typeof query === "string" ? query.length : 0,
      hasFiles: Array.isArray(files) && files.length > 0,
    });
    const agentRes = await axios.post(
      EDIT_AGENT_START_ENDPOINT,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${AUTHORIZE_TOKEN}`,
          subdomain: AGENT_SUBDOMAIN,
          "x-user-type": AGENT_USER_TYPE,
        },
      }
    );

    console.log('AGENTRES:',agentRes?.data);
    

    const aiResult = agentRes?.data?.workflowlog?.tasks?.find(
      (t) => t.tool === "gemini-edit-images-(nano-banana)"
    )?.result?.data;

    console.log("AI Result For Abyath:", aiResult);

    const imageUrl = aiResult?.s3_url;
    const iterationName = aiResult?.name || "AI Design Preview";
    const promptText =
      aiResult?.description ||
      "Here’s the updated design based on your preferences.";

    if (!imageUrl) {
      throw new Error("Agent workflow did not return an image URL.");
    }

    // 1️⃣ Upload image to WhatsApp to get a mediaId
    const mediaId = await uploadImageToWhatsApp(imageUrl);
    console.log(`✅ Uploaded image. Media ID: ${mediaId}`);

    const messageText = [
      `🖼️ *${iterationName}*`,
      promptText,
      "Choose *Looks Good* to keep this design, or *Edit Again* to tweak, add, or remove reference images.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const actionOptions = [
      { id: "edit_result_ok", title: "Looks Good" },
      { id: "edit_result_refine", title: "Edit Again" },
      { id: "edit_result_preferences", title: "Edit Preferences" },
    ];

    const fallbackPinnedImage =
      Array.isArray(files) && files.length > 0
        ? files.find(
            (file) =>
              file.isPrimary && (file.uploadedUrl || file.sourceUrl || file.mediaId)
          ) ||
          null
        : null;

    const refineBaseImage = fallbackPinnedImage || null;

    const refineImageMeta = refineBaseImage
      ? {
          primaryImageUrl: refineBaseImage.uploadedUrl || refineBaseImage.sourceUrl || null,
          primaryCaption: refineBaseImage.caption || null,
          primaryImageMediaId: refineBaseImage.mediaId || null,
          primaryImageWhatsAppId: refineBaseImage.whatsAppMediaId || refineBaseImage.mediaId || null,
        }
      : {
          primaryImageUrl: imageUrl,
          primaryCaption: iterationName,
          primaryImageMediaId: mediaId,
          primaryImageWhatsAppId: mediaId,
        };

    const editPreferencesMeta = {
      primaryImageUrl: imageUrl,
      primaryCaption: iterationName,
      primaryImageMediaId: mediaId,
      primaryImageWhatsAppId: mediaId,
    };

    // 2️⃣ Send interactive reply to WhatsApp user
    await sendInteractiveButtonMessage(to, messageText, actionOptions, mediaId);

    userInspirationContext[to] = {
      preview: null,
      timestamp: Date.now(),
      actions: {
        edit_result_ok: { action: "final_design_accept" },
        edit_result_refine: {
          action: "restart_edit_session",
          ...refineImageMeta,
        },
        edit_result_preferences: {
          action: "start_edit_preferences",
          ...editPreferencesMeta,
        },
      },
    };




  } catch (err) {
    console.error("❌ Agent API error:", err.response?.data || err.message);
    await sendTextMessage(
      to,
      "⚠️ Something went wrong while generating your design. Please try again later."
    );
  } finally {
    if (typingMessageId) {
      await sendTypingIndicator(to, typingMessageId, false);
    }
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
  let uploadBuffer = buffer;
  let uploadMimeType = mimeType;
  let uploadFilename = filename;

  // 🧠 Convert WebP → PNG before upload
  if (mimeType === "image/webp" || filename.toLowerCase().endsWith(".webp")) {
    console.warn("Converting .webp to .png before upload...");
    uploadBuffer = await sharp(buffer).png().toBuffer();
    uploadMimeType = "image/png";
    uploadFilename = filename.replace(/\.webp$/i, ".png");
  }
  const formData = new FormData();
  formData.append("files", uploadBuffer, {
      filename: uploadFilename,
      contentType: uploadMimeType,
 });
  const res = await axios.post(
    "https://api.gettaskagent.com/api/file/upload",
    formData,
    { headers: { ...formData.getHeaders() } }
  );

  const uploadedUrls = res.data?.files?.map((f) => f.Location);
  return {
    uploadedUrls,
    buffer: uploadBuffer,
    mimeType: uploadMimeType,
    filename: uploadFilename,
  };
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
async function sendImageReply(to, mediaId, iterationName, promptText) {
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
          caption: `🖼️ *AI Design Preview*\n\n*${iterationName}*\n\n${promptText}\n\nHere’s your personalized design idea from *AI Home Designer* 🧠✨`,
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

// ✅ Typing Indicator Sender
async function sendTypingIndicator(to, messageId, isTyping) {
  if (!messageId) {
    return;
  }

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
// ✅ Button message sender
async function sendButtonMessage(
  to,
  text,
  options,
  header = null,
  { includeFooter = true } = {}
) {
  const bodyText = includeFooter ? appendFooterText(text) : text;

  const interactive = {
    type: "button",
    body: { text: bodyText },
    action: {
      buttons: options.map((opt) => ({
        type: "reply",
        reply: { id: opt.id, title: opt.title },
      })),
    },
  };

  if (header) {
    if (header.imageId) {
      interactive.header = {
        type: "image",
        image: { id: header.imageId },
      };
    } else if (header.imageUrl) {
      interactive.header = {
        type: "image",
        image: { link: header.imageUrl },
      };
    } else if (header.text) {
      interactive.header = {
        type: "text",
        text: truncate(String(header.text), 60),
      };
    }
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive,
  };

  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}


async function sendInteractiveButtonMessage(
  to,
  text,
  options,
  mediaId = null,
  headerText = null
) {
  const header =
    mediaId || headerText
      ? {
          ...(mediaId ? { imageId: mediaId } : {}),
          ...(headerText ? { text: headerText } : {}),
        }
      : null;

  return sendButtonMessage(to, text, options, header, { includeFooter: false });
}


// ✅ List message sender
async function sendListMessage(to, text, options) {
  const bodyText = appendFooterText(text);

  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "🏡 ABYAT Imagine – Design Inspiration" },
        body: { text: bodyText },
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


// 🔹 Reusable text message sender
async function sendTextMessage(to, message) {
  const body = appendFooterText(message);

  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
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