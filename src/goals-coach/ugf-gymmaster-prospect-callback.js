"use strict";

const crypto = require("node:crypto");
const { exactMemberPortalBaseUrl } = require("./gymmaster-public-widgets");

const PROSPECT_CALLBACK_FLAG = "UGF_GYMMASTER_PROSPECT_CALLBACK_ENABLED";
const PROSPECT_PATH = "/portal/api/v1/prospect/create";
const MEMBER_EXISTS_PATH = "/portal/api/v2/member/exists";
const DEFAULT_TIMEOUT_MILLISECONDS = 5000;
const STAFF_SUPPORT_EMAIL = "staff@ugf.club";
const SALES_INQUIRY_TYPES = new Set(["callback", "free_week_trial", "price_match"]);
const SUPPORT_INQUIRY_TYPES = new Set(["account_help", "access_help", "membership_help", "facility_issue"]);

function enabled(value) {
  return value === "true";
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M}'’ -]*$/u.test(name)) return null;
  return name;
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLocaleLowerCase("en-US");
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizePhone(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function normalizeLocation(value) {
  return value === "black_hawk" || value === "rapid_valley" ? value : null;
}

function normalizeInquiryType(value) {
  if (value === undefined) return "callback";
  return SALES_INQUIRY_TYPES.has(value) || SUPPORT_INQUIRY_TYPES.has(value) ? value : null;
}

function inquiryNote(value) {
  if (value === "free_week_trial") return "Website free-week trial request (new members only). Contact information submitted with explicit consent.";
  if (value === "price_match") return "Website 24/7 gym price-matching inquiry. Contact information submitted with explicit consent.";
  return "Website callback request. Contact information submitted with explicit consent.";
}

function inquiryLabel(value) {
  return Object.freeze({
    callback: "General callback",
    free_week_trial: "Free-week trial",
    price_match: "Price matching",
    account_help: "Login or account help",
    access_help: "Gym access help",
    membership_help: "Membership help",
    facility_issue: "Facility issue",
  })[value];
}

function normalizeSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const allowed = new Set(["firstName", "lastName", "email", "phone", "location", "inquiryType", "consent", "website"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.consent !== true
    || (body.website !== undefined && body.website !== "")) return null;
  const submission = {
    firstName: normalizeName(body.firstName),
    lastName: normalizeName(body.lastName),
    email: normalizeEmail(body.email),
    phone: normalizePhone(body.phone),
    location: normalizeLocation(body.location),
    inquiryType: normalizeInquiryType(body.inquiryType),
  };
  return Object.values(submission).some((value) => !value) ? null : Object.freeze(submission);
}

function multipartBody(fields) {
  const boundary = `----------------UGF${crypto.randomBytes(12).toString("hex")}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return Object.freeze({ boundary, body: Buffer.from(chunks.join(""), "utf8") });
}

function createGymMasterProspectClient(options = {}) {
  const baseUrl = exactMemberPortalBaseUrl(options.baseUrl);
  const apiKey = options.apiKey;
  const companyIds = options.companyIds;
  const fetchImpl = options.fetchImpl;
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds) && options.timeoutMilliseconds > 0
    ? options.timeoutMilliseconds : DEFAULT_TIMEOUT_MILLISECONDS;
  if (!baseUrl || typeof apiKey !== "string" || apiKey.length < 8
    || !companyIds || !Number.isInteger(companyIds.black_hawk) || companyIds.black_hawk < 1
    || !Number.isInteger(companyIds.rapid_valley) || companyIds.rapid_valley < 1
    || companyIds.black_hawk === companyIds.rapid_valley || typeof fetchImpl !== "function") {
    throw new Error("GymMaster prospect client configuration is invalid");
  }

  async function requestJson(pathname, requestOptions) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetchImpl(requestOptions.url, { ...requestOptions.options, redirect: "error", signal: controller.signal });
      if (!response || response.status !== 200 || typeof response.json !== "function") throw new Error("unavailable");
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || payload.error) throw new Error("unavailable");
      return payload;
    } catch (_) {
      throw new Error(`GymMaster ${pathname} is unavailable`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function postMultipart(pathname, fields) {
    const url = new URL(baseUrl); url.pathname = pathname; url.search = "";
    const multipart = multipartBody(fields);
    return requestJson(pathname, {
      url: url.toString(),
      options: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
          "X-GM-API-KEY": apiKey,
        },
        body: multipart.body,
      },
    });
  }

  async function get(pathname, parameters) {
    const url = new URL(baseUrl); url.pathname = pathname; url.search = "";
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
    return requestJson(pathname, {
      url: url.toString(),
      options: { method: "GET", headers: { Accept: "application/json", "X-GM-API-KEY": apiKey } },
    });
  }

  return Object.freeze({
    async classify(submission) {
      try {
        const emailCheck = await get(MEMBER_EXISTS_PATH, { email: submission.email });
        if (emailCheck.result && typeof emailCheck.result === "object"
          && Number.isInteger(emailCheck.result.id) && emailCheck.result.id > 0) return "existing_member";
        if (typeof emailCheck.result !== "string") return "unknown";
        return "new_contact";
      } catch (_) {
        return "unknown";
      }
    },
    async create(submission) {
      const result = await postMultipart(PROSPECT_PATH, {
        firstname: submission.firstName,
        surname: submission.lastName,
        email: submission.email,
        companyid: String(companyIds[submission.location]),
        phonecell: submission.phone,
        notes: inquiryNote(submission.inquiryType),
      });
      if (!Number.isInteger(result.memberid) || result.memberid < 1) {
        throw new Error("GymMaster prospect creation is unavailable");
      }
    },
  });
}

function createStaffSupportClient(options = {}) {
  let endpoint;
  try {
    endpoint = new URL(options.endpoint);
  } catch (_) {
    throw new Error("Staff support endpoint is invalid");
  }
  const secret = options.secret;
  const fetchImpl = options.fetchImpl;
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds) && options.timeoutMilliseconds > 0
    ? options.timeoutMilliseconds : DEFAULT_TIMEOUT_MILLISECONDS;
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash
    || endpoint.search || endpoint.pathname !== "/wp-json/ugf/v1/help-followup"
    || typeof secret !== "string" || secret.length < 32 || typeof fetchImpl !== "function") {
    throw new Error("Staff support endpoint is invalid");
  }
  return Object.freeze({
    async send(submission, classification) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
      try {
        const response = await fetchImpl(endpoint.toString(), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-UGF-Help-Secret": secret,
          },
          body: JSON.stringify({
            recipient: STAFF_SUPPORT_EMAIL,
            staffLabel: classification === "existing_member" ? "Existing member" : "Possible member",
            topic: inquiryLabel(submission.inquiryType),
            firstName: submission.firstName,
            lastName: submission.lastName,
            email: submission.email,
            phone: submission.phone,
            location: submission.location,
          }),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response || response.status !== 200 || typeof response.json !== "function") throw new Error("unavailable");
        const result = await response.json();
        if (!result || result.ok !== true) throw new Error("unavailable");
      } catch (_) {
        throw new Error("Staff support delivery is unavailable");
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

function createProspectCallbackHandler(options = {}) {
  const client = options.client;
  const supportClient = options.supportClient;
  if (!client || typeof client.classify !== "function" || typeof client.create !== "function"
    || !supportClient || typeof supportClient.send !== "function") throw new Error("Prospect callback requires provider clients");
  return async function submitProspectCallback(req, res) {
    const submission = normalizeSubmission(req && req.body);
    if (!submission) return res.status(400).json({ error: "Enter a valid name, email, phone number, location, and consent." });
    try {
      const classification = await client.classify(submission);
      if (classification === "new_contact" && SALES_INQUIRY_TYPES.has(submission.inquiryType)) {
        await client.create(submission);
      } else {
        await supportClient.send(submission, classification);
      }
      res.set("Cache-Control", "no-store");
      return res.status(201).json({
        ok: true,
        message: "Thanks. UGF staff will use the contact information you provided to follow up.",
      });
    } catch (_) {
      return res.status(503).json({ error: "Callback requests are temporarily unavailable. Please try again shortly." });
    }
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MILLISECONDS,
  MEMBER_EXISTS_PATH,
  PROSPECT_CALLBACK_FLAG,
  PROSPECT_PATH,
  createGymMasterProspectClient,
  createProspectCallbackHandler,
  createStaffSupportClient,
  enabled,
  multipartBody,
  normalizeEmail,
  normalizeInquiryType,
  normalizeLocation,
  normalizeName,
  normalizePhone,
  normalizeSubmission,
};
