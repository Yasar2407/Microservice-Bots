const FILTER_KEY_MAP = {
  livingRoomLayout: "livingRoomLayouts",
  livingRoomSpace: "livingRoomSpaces",
  diningRoomType: "diningRoomTypes",
  diningRoomTableSize: "diningRoomTableSizes",
  bedroomType: "bedroomTypes",
  bedroomBedSize: "bedroomBedSizes",
  outdoorSpace: "outdoorSpaces",
  outdoorFeature: "outdoorFeatures",
};

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function serializePrices(prices) {
  if (!prices || typeof prices !== "object") return [];

  const hasMin = typeof prices.min === "number";
  const hasMax = typeof prices.max === "number";

  if (!hasMin && !hasMax) {
    return [];
  }

  const min = hasMin ? prices.min : prices.max;
  const max = hasMax ? prices.max : prices.min;

  return [{ min, max }];
}

function serializeFilters(filters = {}) {
  const result = {
    rooms: ensureArray(filters.rooms),
    colors: ensureArray(filters.colors),
    styles: ensureArray(filters.styles),
    lightingAndAtmospheres: ensureArray(filters.lightingAndAtmospheres),
    prices: serializePrices(filters.prices),
    categorization: [],
    inStockPercentage: { min: 80 },
  };

  Object.entries(FILTER_KEY_MAP).forEach(([stateKey, apiKey]) => {
    const value = filters[stateKey];
    if (Array.isArray(value) && value.length > 0) {
      result[apiKey] = value;
    }
  });

  return result;
}

function buildDesignSearchPayload(state = {}) {
  const payload = {
    locale: state.locale ?? "en-SA",
    currency: state.currency ?? "SAR",
    marketplace: state.marketplace ?? "ABYAT_SA",
    seed: state.seed ?? undefined,
    size: state.size ?? 20,
    page: state.page ?? 0,
    filters: serializeFilters(state.filters ?? {}),
    facets: state.currentFacets ?? state.facets ?? [],
  };

  if (payload.seed === undefined) {
    delete payload.seed;
  }

  return payload;
}

const ARRAY_FACET_KEYS = [
  "rooms",
  "colors",
  "styles",
  "lightingAndAtmospheres",
  "livingRoomLayout",
  "livingRoomSpace",
  "diningRoomType",
  "diningRoomTableSize",
  "bedroomType",
  "bedroomBedSize",
  "outdoorSpace",
  "outdoorFeature",
];

function normalizeFacetCounts(data) {
  if (!data || typeof data !== "object") return data;
  if (!data.facetCounts || typeof data.facetCounts !== "object") return data;

  const facetCounts = { ...data.facetCounts };

  if (Array.isArray(facetCounts.prices)) {
    const prices = facetCounts.prices;
    const minCandidates = prices
      .map((p) => (typeof p?.min === "number" ? p.min : undefined))
      .filter((v) => v !== undefined);
    const maxCandidates = prices
      .map((p) => (typeof p?.max === "number" ? p.max : undefined))
      .filter((v) => v !== undefined);

    const min =
      minCandidates.length > 0
        ? Math.min(...minCandidates)
        : typeof prices[0]?.min === "number"
        ? prices[0].min
        : undefined;
    const max =
      maxCandidates.length > 0
        ? Math.max(...maxCandidates)
        : typeof prices[prices.length - 1]?.max === "number"
        ? prices[prices.length - 1].max
        : undefined;

    const segments = prices
      .map((p) => (typeof p?.min === "number" ? p.min : undefined))
      .filter((value, index, all) => value !== undefined && all.indexOf(value) === index);

    facetCounts.prices = {
      min,
      max,
      segments,
      ranges: prices
        .map((p) => {
          const rangeMin = typeof p?.min === "number" ? p.min : undefined;
          const rangeMax = typeof p?.max === "number" ? p.max : undefined;
          if (rangeMin === undefined && rangeMax === undefined) return null;
          return {
            min: rangeMin,
            max: rangeMax,
            count:
              typeof p?.count === "number"
                ? p.count
                : typeof p?.total === "number"
                ? p.total
                : typeof p?.valueCount === "number"
                ? p.valueCount
                : undefined,
          };
        })
        .filter(Boolean),
    };
  }

  const facetMap = {
    livingRoomLayoutCounts: "livingRoomLayout",
    livingRoomSpaceCounts: "livingRoomSpace",
    diningRoomTypeCounts: "diningRoomType",
    diningRoomTableSizeCounts: "diningRoomTableSize",
    bedroomTypeCounts: "bedroomType",
    bedroomBedSizeCounts: "bedroomBedSize",
    outdoorSpaceCounts: "outdoorSpace",
    outdoorFeatureCounts: "outdoorFeature",
  };

  Object.entries(facetMap).forEach(([oldKey, newKey]) => {
    if (Object.prototype.hasOwnProperty.call(facetCounts, oldKey)) {
      const value = facetCounts[oldKey];
      if (Array.isArray(value)) {
        facetCounts[newKey] = value;
      } else if (value == null) {
        facetCounts[newKey] = [];
      } else {
        facetCounts[newKey] = value;
      }
      delete facetCounts[oldKey];
    }
  });

  ARRAY_FACET_KEYS.forEach((key) => {
    if (key in facetCounts && facetCounts[key] == null) {
      facetCounts[key] = [];
    }
  });

  return { ...data, facetCounts };
}

function humanizeLabel(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function formatSar(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat("en-SA", {
      style: "currency",
      currency: "SAR",
      maximumFractionDigits: 0,
    }).format(value);
  } catch (err) {
    // Fallback if Intl is unavailable for any reason
    return `SAR ${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
}

function buildPriceFacetOptions(rawFacet, limit = 10) {
  if (!rawFacet) return [];

  const rangesSource = Array.isArray(rawFacet)
    ? rawFacet.map((entry) => ({
        min: typeof entry?.min === "number" ? entry.min : undefined,
        max: typeof entry?.max === "number" ? entry.max : undefined,
        count:
          typeof entry?.count === "number"
            ? entry.count
            : typeof entry?.total === "number"
            ? entry.total
            : typeof entry?.valueCount === "number"
            ? entry.valueCount
            : undefined,
      }))
    : Array.isArray(rawFacet?.ranges)
    ? rawFacet.ranges
    : [];

  const ranges = rangesSource
    .map((entry) => {
      const min = typeof entry?.min === "number" ? entry.min : undefined;
      const max = typeof entry?.max === "number" ? entry.max : undefined;
      const count =
        typeof entry?.count === "number"
          ? entry.count
          : typeof entry?.total === "number"
          ? entry.total
          : typeof entry?.valueCount === "number"
          ? entry.valueCount
          : undefined;

      if (min === undefined && max === undefined) {
        return null;
      }

      if (min !== undefined && max !== undefined && min > max) {
        return {
          min: max,
          max: min,
          count,
        };
      }

      return {
        min,
        max,
        count,
      };
    })
    .filter(Boolean);

  const normalized = [];
  const seenKeys = new Set();

  ranges.forEach((range, index) => {
    const { min, max, count } = range;
    if (min === undefined || max === undefined || min === max) {
      return;
    }

    const key = `${min}-${max}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const formattedMin = formatSar(min);
    const formattedMax = formatSar(max);

    const label =
      formattedMin && formattedMax
        ? `${formattedMin} - ${formattedMax}`
        : formattedMin || formattedMax || key;

    normalized.push({
      id: `prices_${normalized.length + 1}`,
      value: key,
      count,
      label,
      description: "Tap to set budget range",
    });
  });

  normalized.sort((a, b) => {
    const [aMin] = a.value.split("-").map(Number);
    const [bMin] = b.value.split("-").map(Number);
    return aMin - bMin;
  });

  return normalized.slice(0, limit);
}

function extractFacetOptions(facetCounts = {}, facetKey, options = {}) {
  if (!facetKey || !facetCounts) return [];

  const limit = typeof options.limit === "number" ? options.limit : 10;
  const includeCounts = options.includeCounts !== false;

  const facet = facetCounts[facetKey];
  if (!facet) return [];

  if (facetKey === "prices") {
    const priceOptions = buildPriceFacetOptions(facet, limit);
    return priceOptions.map((option) => ({
      id: option.id,
      title:
        includeCounts && typeof option.count === "number"
          ? `${option.label} (${option.count})`
          : option.label,
      description: option.description,
      value: option.value,
      count: option.count,
    }));
  }

  let entries = [];

  if (Array.isArray(facet)) {
    entries = facet
      .map((item, index) => {
        if (!item) return null;

        const value = item.value ?? item.name ?? item.option ?? item.id ?? item;
        const count = item.count ?? item.total ?? item.valueCount ?? item.score;
        if (!value) return null;

        return {
          id: item.id ?? `${facetKey}_${index + 1}`,
          value,
          count: typeof count === "number" ? count : undefined,
          label: humanizeLabel(value),
        };
      })
      .filter(Boolean);
  } else if (typeof facet === "object") {
    entries = Object.entries(facet).map(([value, count], index) => ({
      id: `${facetKey}_${index + 1}`,
      value,
      count: typeof count === "number" ? count : undefined,
      label: humanizeLabel(value),
    }));
  }

  entries.sort((a, b) => {
    const countA = typeof a.count === "number" ? a.count : -1;
    const countB = typeof b.count === "number" ? b.count : -1;

    if (countA === countB) {
      return String(a.label).localeCompare(String(b.label));
    }

    return countB - countA;
  });

  return entries.slice(0, limit).map((entry, index) => ({
    id: entry.id ?? `${facetKey}_${index + 1}`,
    title:
      includeCounts && typeof entry.count === "number"
        ? `${entry.label} (${entry.count})`
        : entry.label,
    description: entry.value && entry.value !== entry.label ? String(entry.value) : "",
    value: entry.value,
    count: entry.count,
  }));
}

module.exports = {
  extractFacetOptions,
  buildDesignSearchPayload,
  normalizeFacetCounts,
};


