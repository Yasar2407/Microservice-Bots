const { buildDesignSearchPayload } = require("./designSearchService");

function withTruthy(target, key, value) {
  if (value === undefined || value === null || value === "") {
    return target;
  }
  return { ...target, [key]: value };
}

function createAgentQueryPayload({
  queryText,
  messageType = "text",
  sessionId,
  currentStep,
  designSearchState,
  selection,
  facetKey,
  facetValue,
  facets = {},
}) {
  let payload = {
    queryText,
    messageType,
    sentAt: new Date().toISOString(),
  };

  payload = withTruthy(payload, "sessionId", sessionId);
  payload = withTruthy(payload, "currentStep", currentStep);
  payload = withTruthy(payload, "facetKey", facetKey);
  payload = withTruthy(payload, "facetValue", facetValue);

  if (selection && typeof selection === "object") {
    payload.selection = selection;
  }

  if (designSearchState && typeof designSearchState === "object") {
    payload.designSearchState = designSearchState;
    try {
      payload.designSearchPayload = buildDesignSearchPayload(designSearchState);
    } catch (err) {
      console.error("createAgentQueryPayload: unable to build design payload", err.message);
    }
  }

  if (facets && typeof facets === "object") {
    payload = withTruthy(payload, "facetCounts", facets);
  }

  return payload;
}

module.exports = {
  createAgentQueryPayload,
};

