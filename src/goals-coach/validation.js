const crypto = require("crypto");

function positiveId(value, fieldName) {
  const normalized = String(value || "");
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    const error = new Error(`${fieldName} must be a positive integer`);
    error.statusCode = 400;
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return normalized;
}

function optionalPositiveId(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  return positiveId(value, fieldName);
}

function messageContent(value) {
  const content = String(value || "").trim();
  if (!content || content.length > 8000) {
    const error = new Error("Message content must contain 1 to 8000 characters");
    error.statusCode = 400;
    error.code = "INVALID_MESSAGE";
    throw error;
  }
  return content;
}

function clientMessageId(value) {
  if (value === undefined || value === null || value === "") return crypto.randomUUID();
  const normalized = String(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    const error = new Error("clientMessageId must be a UUID");
    error.statusCode = 400;
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return normalized;
}

function requiredClientMessageId(value) {
  if (value === undefined || value === null || value === "") {
    const error = new Error("clientMessageId is required");
    error.statusCode = 400;
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return clientMessageId(value);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function decodeCursor(value, requiredKeys) {
  if (value === undefined || value === null || value === "") return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!decoded || decoded.v !== 1) throw new Error("invalid version");
    for (const key of requiredKeys) {
      if (decoded[key] === undefined || decoded[key] === null || decoded[key] === "") {
        throw new Error("missing cursor key");
      }
    }
    return decoded;
  } catch (_) {
    const error = new Error("cursor is invalid");
    error.statusCode = 400;
    error.code = "INVALID_CURSOR";
    throw error;
  }
}

function enumValue(value, fieldName, allowed) {
  if (!allowed.includes(value)) {
    const error = new Error(`${fieldName} must be one of: ${allowed.join(", ")}`);
    error.statusCode = 400;
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return value;
}

function optionalText(value, fieldName, maxLength) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maxLength) {
    const error = new Error(`${fieldName} must contain 1 to ${maxLength} characters`);
    error.statusCode = 400;
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return normalized;
}

function optionalDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    const error = new Error(`${fieldName} must be a valid YYYY-MM-DD date`);
    error.statusCode = 400;
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return normalized;
}

function pageLimit(value) {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    const error = new Error("limit must be an integer from 1 to 100");
    error.statusCode = 400;
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return parsed;
}

module.exports = {
  clientMessageId,
  decodeCursor,
  encodeCursor,
  enumValue,
  messageContent,
  optionalDate,
  optionalPositiveId,
  optionalText,
  pageLimit,
  positiveId,
  requiredClientMessageId,
};
