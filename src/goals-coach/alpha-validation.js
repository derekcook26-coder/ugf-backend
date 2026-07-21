const { enumValue, optionalText, positiveId, requiredClientMessageId } = require("./validation");
const { canonicalUuid } = require("./transcription-adapter");

const ALPHA_MESSAGE_FIELDS = new Set([
  "content",
  "clientMessageId",
  "inputMethod",
  "transcriptionId",
]);

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "INVALID_REQUEST";
  throw error;
}

function requiredText(value, fieldName, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    invalid(`${fieldName} must contain 1 to ${maxLength} characters`);
  }
  return normalized;
}

function requiredMessageContent(value) {
  if (typeof value !== "string") {
    invalid("content must be a string");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 8000) {
    invalid("content must contain 1 to 8000 characters");
  }
  return normalized;
}

function optionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid(`${fieldName} must be a boolean`);
  return value;
}

function optionalTimestamp(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value);
  if (Number.isNaN(Date.parse(normalized))) invalid(`${fieldName} must be a valid timestamp`);
  return new Date(normalized).toISOString();
}

function optionalTime(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value);
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(normalized)) {
    invalid(`${fieldName} must be a valid 24-hour time`);
  }
  return normalized;
}

function consentInput(body) {
  return {
    action: enumValue(body && body.action, "action", ["accept", "decline", "withdraw"]),
  };
}

function preferenceInput(body) {
  const input = {
    voiceInputEnabled: optionalBoolean(body && body.voiceInputEnabled, "voiceInputEnabled"),
    spokenResponsesEnabled: optionalBoolean(body && body.spokenResponsesEnabled, "spokenResponsesEnabled"),
    automaticPlayback: optionalBoolean(body && body.automaticPlayback, "automaticPlayback"),
    reducedMotion: optionalBoolean(body && body.reducedMotion, "reducedMotion"),
    largerText: optionalBoolean(body && body.largerText, "largerText"),
    privateNotificationPreviews: optionalBoolean(
      body && body.privateNotificationPreviews,
      "privateNotificationPreviews"
    ),
    notificationFrequency: body && body.notificationFrequency === undefined
      ? undefined
      : enumValue(body.notificationFrequency, "notificationFrequency", ["off", "daily", "weekly"]),
    quietHoursStart: body && body.quietHoursStart === undefined
      ? undefined
      : optionalTime(body.quietHoursStart, "quietHoursStart"),
    quietHoursEnd: body && body.quietHoursEnd === undefined
      ? undefined
      : optionalTime(body.quietHoursEnd, "quietHoursEnd"),
    quietHoursTimezone: body && body.quietHoursTimezone === undefined
      ? undefined
      : optionalText(body.quietHoursTimezone, "quietHoursTimezone", 100),
  };
  if (!Object.values(input).some((value) => value !== undefined)) {
    invalid("At least one preference is required");
  }
  const quietValues = [input.quietHoursStart, input.quietHoursEnd, input.quietHoursTimezone];
  const providedQuietValues = quietValues.filter((value) => value !== undefined);
  if (providedQuietValues.length && providedQuietValues.length !== 3) {
    invalid("quietHoursStart, quietHoursEnd, and quietHoursTimezone must be changed together");
  }
  return input;
}

function feedbackInput(body) {
  return {
    conversationId: body && body.conversationId
      ? positiveId(body.conversationId, "conversationId")
      : null,
    expectation: requiredText(body && body.expectation, "expectation", 2000),
    whatOccurred: requiredText(body && body.whatOccurred, "whatOccurred", 4000),
    pageOrFeature: requiredText(body && body.pageOrFeature, "pageOrFeature", 200),
    approximateTime: optionalTimestamp(body && body.approximateTime, "approximateTime"),
    severity: enumValue(body && body.severity, "severity", ["low", "medium", "high", "blocking"]),
    comments: optionalText(body && body.comments, "comments", 4000),
    appVersion: optionalText(body && body.appVersion, "appVersion", 100),
    browser: optionalText(body && body.browser, "browser", 200),
    deviceType: optionalText(body && body.deviceType, "deviceType", 200),
  };
}

function alphaMessageInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    invalid("Message body must be an object");
  }
  for (const field of Object.keys(body)) {
    if (!ALPHA_MESSAGE_FIELDS.has(field)) {
      invalid(`Unknown message field: ${field}`);
    }
  }

  const inputMethod = body.inputMethod === undefined
    ? "text"
    : enumValue(body.inputMethod, "inputMethod", ["text", "voice"]);
  const input = {
    content: requiredMessageContent(body.content),
    clientMessageId: requiredClientMessageId(body && body.clientMessageId),
    inputMethod,
  };
  if (inputMethod === "text") {
    if (body.transcriptionId !== undefined) {
      invalid("transcriptionId is not permitted for text input");
    }
    return input;
  }
  if (!canonicalUuid(body.transcriptionId)) {
    invalid("transcriptionId must be a canonical lowercase UUID");
  }
  return { ...input, transcriptionId: body.transcriptionId };
}

module.exports = {
  alphaMessageInput,
  consentInput,
  feedbackInput,
  preferenceInput,
};
