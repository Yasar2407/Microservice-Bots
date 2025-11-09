function unwrapDesignResult(candidate, depth = 0) {
  if (!candidate || depth > 4) return null;

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const unwrapped = unwrapDesignResult(item, depth + 1);
      if (unwrapped) return unwrapped;
    }
    return null;
  }

  if (typeof candidate !== "object") {
    return null;
  }

  if (
    candidate.facetCounts ||
    candidate.inspirations ||
    candidate.results ||
    typeof candidate.total === "number"
  ) {
    return candidate;
  }

  const nestedKeys = ["data", "payload", "value", "result", "response"];
  for (const key of nestedKeys) {
    if (candidate[key]) {
      const nested = unwrapDesignResult(candidate[key], depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

function extractDesignResponseFromAgent(agentData) {
  const tasks = agentData?.workflowlog?.tasks;
  if (!Array.isArray(tasks)) {
    return null;
  }

  for (const task of tasks) {
    const candidate = unwrapDesignResult(task?.result?.data || task?.result);
    // console.log("🧠 Candidate:", candidate);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractAgentSummaryText(agentData) {
  const tasks = agentData?.workflowlog?.tasks;
  if (!Array.isArray(tasks)) {
    return null;
  }

  for (const task of tasks) {
    if (task?.tool === "owncondition") {
      const data = task?.result?.data;
      if (typeof data === "string") {
        console.log("🧠 Agent summary text:", data);
        return data;
      }

      if (data && typeof data === "object") {
        if (typeof data.message === "string") {
          console.log("🧠 Agent summary message:", data.message);
          return data.message;
        }
        if (typeof data.text === "string") {
          console.log("🧠 Agent summary text field:", data.text);
          return data.text;
        }
      }
    }
  }

  return null;
}

module.exports = {
  extractDesignResponseFromAgent,
  extractAgentSummaryText,
};

