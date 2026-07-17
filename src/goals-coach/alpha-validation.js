const { enumValue, optionalText, positiveId, requiredClientMessageId } = require("./validation");

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
  return {
    content: requiredText(body && body.content, "content", 8000),
    clientMessageId: requiredClientMessageId(body && body.clientMessageId),
  };
}

module.exports = {
  alphaMessageInput,
  consentInput,
  feedbackInput,
  preferenceInput,
};
