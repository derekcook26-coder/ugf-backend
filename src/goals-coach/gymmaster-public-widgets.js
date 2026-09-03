"use strict";

const WIDGETS_FLAG = "UGF_GYMMASTER_WIDGETS_ENABLED";
const SCHEDULE_PATH = "/portal/api/v1/booking/classes/schedule";
const MEMBERSHIPS_PATH = "/portal/api/v1/memberships";
const SCHEDULE_CACHE_MILLISECONDS = 5 * 60 * 1000;
const MEMBERSHIPS_CACHE_MILLISECONDS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MILLISECONDS = 5000;
const EXCLUDED_MEMBERSHIP_DIVISIONS = new Set(["tv service"]);

function widgetsEnabled(value) {
  return value === "true";
}

function exactMemberPortalBaseUrl(value) {
  if (typeof value !== "string" || !value) return null;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "ugf.gymmasteronline.com"
    || url.pathname !== "/portal/api/v1/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) return null;
  return url.toString();
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function stringOrEmpty(value, maximum = 500) {
  if (typeof value !== "string") return "";
  return value.slice(0, maximum);
}

function booleanValue(value) {
  return value === true;
}

function sanitizeScheduleItem(item) {
  if (!item || typeof item !== "object" || !Number.isInteger(item.id)) return null;
  return Object.freeze({
    id: item.id,
    name: stringOrEmpty(item.name, 120),
    arrival: stringOrEmpty(item.arrival, 10),
    dayOfWeek: stringOrEmpty(item.dayofweek, 20),
    startTime: stringOrEmpty(item.starttime, 20),
    endTime: stringOrEmpty(item.endtime, 20),
    availability: stringOrEmpty(item.availability, 80),
    location: stringOrEmpty(item.location, 120),
    description: stringOrEmpty(item.description, 1000),
    companyId: integerOrNull(item.companyid),
    companyName: stringOrEmpty(item.companyname, 120),
    capacity: integerOrNull(item.max_students),
    spacesFree: integerOrNull(item.spacesfree),
  });
}

function sanitizeMembershipItem(item) {
  if (!item || typeof item !== "object" || !Number.isInteger(item.id)) return null;
  const divisionName = stringOrEmpty(item.divisionname, 160);
  if (EXCLUDED_MEMBERSHIP_DIVISIONS.has(divisionName.trim().toLowerCase())) return null;
  const companyIds = Array.isArray(item.companyids)
    ? item.companyids.filter(Number.isInteger).slice(0, 20)
    : [];
  return Object.freeze({
    id: item.id,
    name: stringOrEmpty(item.name, 160),
    description: stringOrEmpty(item.description, 2000),
    price: stringOrEmpty(item.price, 80),
    priceDescription: stringOrEmpty(item.pricedescription, 500),
    signupFee: stringOrEmpty(item.signupfee, 80),
    signupFeeLabel: stringOrEmpty(item.signupfee_label, 120),
    hideSignupFee: booleanValue(item.hide_signupfee),
    divisionName,
    promotionalPeriod: stringOrEmpty(item.promotional_period, 120),
    promotionalPrice: stringOrEmpty(item.promotional_price, 80),
    promotionDescription: stringOrEmpty(item.promotion_period_description, 500),
    sortOrder: integerOrNull(item.sortorder),
    companyIds,
  });
}

function createProviderClient(options = {}) {
  const baseUrl = exactMemberPortalBaseUrl(options.baseUrl);
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl;
  const timeoutMilliseconds = Number.isInteger(options.timeoutMilliseconds)
    && options.timeoutMilliseconds > 0
    ? options.timeoutMilliseconds
    : DEFAULT_TIMEOUT_MILLISECONDS;
  if (!baseUrl) throw new Error("GymMaster widgets require the exact Member Portal API base URL");
  if (typeof apiKey !== "string" || apiKey.length < 8) {
    throw new Error("GymMaster widgets require a Member Portal API key");
  }
  if (typeof fetchImpl !== "function") throw new Error("GymMaster widgets require fetch");

  async function get(path, query = {}) {
    const url = new URL(baseUrl);
    url.pathname = path;
    url.searchParams.set("api_key", apiKey);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response || response.status !== 200 || typeof response.json !== "function") {
        throw new Error("provider unavailable");
      }
      const body = await response.json();
      if (!body || typeof body !== "object" || body.error || !Array.isArray(body.result)) {
        throw new Error("provider unavailable");
      }
      return body.result;
    } catch (_) {
      throw new Error("GymMaster widget data is unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({
    schedule(week) { return get(SCHEDULE_PATH, { week }); },
    memberships() { return get(MEMBERSHIPS_PATH); },
  });
}

function createCache(now = Date.now) {
  const entries = new Map();
  return Object.freeze({
    async read(key, ttl, load) {
      const current = now();
      const existing = entries.get(key);
      if (existing && existing.expiresAt > current) return existing.value;
      const value = await load();
      entries.set(key, { expiresAt: current + ttl, value });
      return value;
    },
  });
}

function createGymMasterPublicWidgetsRouter(options = {}) {
  const provider = options.provider;
  const cache = options.cache || createCache(options.now);
  const signupUrl = options.signupUrl;
  if (!provider || typeof provider.schedule !== "function" || typeof provider.memberships !== "function") {
    throw new Error("GymMaster widgets router requires a provider");
  }
  if (signupUrl !== "https://ugf.gymmasteronline.com/portal/signup?logo=0") {
    throw new Error("GymMaster widgets require the approved secure signup URL");
  }

  return Object.freeze({
    async schedule(req, res) {
      const week = req && req.query ? req.query.week : undefined;
      if (!validIsoDate(week)) return res.status(400).json({ error: "A valid week is required." });
      try {
        const items = await cache.read(`schedule:${week}`, SCHEDULE_CACHE_MILLISECONDS, async () => {
          const result = await provider.schedule(week);
          return result.map(sanitizeScheduleItem).filter(Boolean);
        });
        res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=240");
        return res.status(200).json({ week, classes: items });
      } catch (_) {
        return res.status(503).json({ error: "Class schedule is temporarily unavailable." });
      }
    },
    async memberships(_req, res) {
      try {
        const items = await cache.read("memberships", MEMBERSHIPS_CACHE_MILLISECONDS, async () => {
          const result = await provider.memberships();
          return result.map(sanitizeMembershipItem).filter(Boolean)
            .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
        });
        res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=60");
        return res.status(200).json({ memberships: items, signupUrl });
      } catch (_) {
        return res.status(503).json({ error: "Memberships are temporarily unavailable." });
      }
    },
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MILLISECONDS,
  MEMBERSHIPS_CACHE_MILLISECONDS,
  MEMBERSHIPS_PATH,
  SCHEDULE_CACHE_MILLISECONDS,
  SCHEDULE_PATH,
  WIDGETS_FLAG,
  createCache,
  createGymMasterPublicWidgetsRouter,
  createProviderClient,
  exactMemberPortalBaseUrl,
  sanitizeMembershipItem,
  sanitizeScheduleItem,
  validIsoDate,
  widgetsEnabled,
};
