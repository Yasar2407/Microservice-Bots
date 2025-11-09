const CDN_BASE = "https://cdn.abyat.com/";

function buildCdnUrl(path) {
  if (!path || typeof path !== "string") return "";
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return `${CDN_BASE}${normalized}`;
}

function toTitleCase(value) {
  if (!value) return "";
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function getInspirationImageUrl(item = {}) {
  if (!item || typeof item !== "object") return "";

  if (item.image && typeof item.image === "object" && item.image.url) {
    return buildCdnUrl(item.image.url);
  }

  if (typeof item.image === "string") {
    return buildCdnUrl(item.image);
  }

  if (item.imageUrl) {
    return buildCdnUrl(item.imageUrl);
  }

  if (Array.isArray(item.media) && item.media[0]?.url) {
    return buildCdnUrl(item.media[0].url);
  }

  if (item.images?.productImages?.[0]) {
    return buildCdnUrl(item.images.productImages[0]);
  }

  return "";
}

function extractProductIdsFromInspiration(design) {
  const ids = new Set();
  const visited = new WeakSet();

  const maybeAddString = (key, value) => {
    if (!value || typeof value !== "string") return;
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("productid") || lowerKey === "product") {
      ids.add(value);
      return;
    }
    if (lowerKey === "id" || lowerKey.endsWith("id")) {
      if (/^\d{3,}$/.test(value)) {
        ids.add(value);
      }
    }
  };

  const walk = (node) => {
    if (!node) return;

    if (Array.isArray(node)) {
      node.forEach((item) => walk(item));
      return;
    }

    if (typeof node === "object") {
      if (visited.has(node)) return;
      visited.add(node);

      if (node.products && typeof node.products === "object" && !Array.isArray(node.products)) {
        Object.keys(node.products).forEach((productId) => {
          if (/^\d{3,}$/.test(productId)) {
            ids.add(productId);
          }
        });
      }

      Object.entries(node).forEach(([key, value]) => {
        if (typeof value === "string") {
          maybeAddString(key, value);
        } else if (Array.isArray(value)) {
          walk(value);
        } else if (value && typeof value === "object") {
          walk(value);
        }
      });
    }
  };

  walk(design);
  return Array.from(ids);
}

module.exports = {
  buildCdnUrl,
  toTitleCase,
  getInspirationImageUrl,
  extractProductIdsFromInspiration,
};

