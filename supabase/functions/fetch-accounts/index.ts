/* fetch-accounts — pull businesses off a list of URLs.

   POST { "urls": ["https://…", …] }  (max 10)
   ->   { "results": [ { url, ok, rows: [...], error? } ] }

   Reads schema.org JSON-LD first, which on directory provider pages and
   better practice sites carries name, phone, address, coordinates and
   day-by-day opening hours. Falls back to reading the rendered text for
   a name, address and phone.

   Pages that draw their listings with script cannot be read here - there
   is no browser in this runtime. botoxcosmetic's /search and /browse are
   both in that category; its individual provider pages are not. */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;
const MAX_URLS = 10;

const ALLOWED = new Set([
  "https://dnarsete.github.io",
  "https://routes.thereflectco.com",
  "http://localhost:5176",
]);

const BIZ = new Set(["localbusiness","medicalbusiness","medicalclinic","medicalorganization",
  "physician","dentist","healthandbeautybusiness","dayspa","beautysalon","hospital",
  "organization","healthclub","professionalservice"]);

const DAYS: Record<string,string> = { monday:"mon", tuesday:"tue", wednesday:"wed",
  thursday:"thu", friday:"fri", saturday:"sat", sunday:"sun" };

const SUF = "(?:Ave|Avenue|St|Street|Rd|Road|Blvd|Boulevard|Dr|Drive|Way|Pkwy|Parkway|Ln|Lane|Ct|Court|Cir|Circle|Pl|Place|Ter|Hwy|Highway)";

function cors(req: Request): HeadersInit {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.has(o) ? o : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

const one = (v: unknown): string => {
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? "" : String(x);
};
const digits = (v: unknown) => one(v).replace(/\D/g, "").slice(-10);

function walk(node: unknown, out: Record<string, unknown>[]) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return; }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const t = o["@type"];
  const types = Array.isArray(t) ? t : (t ? [t] : []);
  if (types.some((x) => BIZ.has(String(x).toLowerCase())) && o.name) out.push(o);
  for (const k of ["@graph","itemListElement","item","mainEntity","subOrganization"]) {
    if (k in o) walk(o[k], out);
  }
}

function hoursOf(n: Record<string, unknown>) {
  const h: Record<string, string[][]> = {};
  let spec = n.openingHoursSpecification as unknown;
  if (spec && !Array.isArray(spec)) spec = [spec];
  for (const sp of (spec as Record<string, unknown>[] || [])) {
    if (!sp || typeof sp !== "object") continue;
    let days = sp.dayOfWeek as unknown;
    if (typeof days === "string") days = [days];
    const o = one(sp.opens), c = one(sp.closes);
    if (!o || !c) continue;
    for (const d of (days as string[] || [])) {
      const k = DAYS[String(d).split("/").pop()!.toLowerCase()];
      if (k) (h[k] ||= []).push([o.slice(0,5), c.slice(0,5)]);
    }
  }
  return h;
}

function splitSuite(street: string) {
  let suite = "";
  let s = street;
  const m = s.match(/\b(?:ste|suite|unit|apt|bldg|fl|floor|rm|room)\b\.?\s*#?\s*([A-Za-z0-9-]+)|#\s*([A-Za-z0-9-]+)/i);
  if (m) {
    suite = (m[1] || m[2] || "").trim();
    s = (s.slice(0, m.index) + " " + s.slice(m.index! + m[0].length)).replace(/\s+/g," ").trim();
  } else {
    /* "4500 E 9th Avenue 640" - a bare number trailing a street suffix */
    const t = s.match(new RegExp("^(.*\\b" + SUF + "\\.?)\\s+([0-9]{1,5}[A-Za-z]?)$", "i"));
    if (t) { suite = t[2]; s = t[1].trim(); }
  }
  return { street: s.replace(/[,\s]+$/,""), suite };
}

function fromJsonLd(doc: string) {
  const found: Record<string, unknown>[] = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    try { walk(JSON.parse(m[1].trim()), found); } catch { /* skip bad block */ }
  }
  const rows = found.map((n) => {
    let a = n.address as Record<string, unknown> | undefined;
    if (Array.isArray(a)) a = a[0];
    if (!a || typeof a !== "object") a = {};
    let g = n.geo as Record<string, unknown> | undefined;
    if (!g || typeof g !== "object") g = {};
    const lat = parseFloat(one(g.latitude)), lng = parseFloat(one(g.longitude));
    const sp = splitSuite(one(a.streetAddress).trim());
    return {
      name: one(n.name).trim(),
      street: sp.street || null,
      suite: sp.suite || null,
      city: one(a.addressLocality).trim() || null,
      state: one(a.addressRegion).trim().slice(0,2).toUpperCase() || null,
      zip: one(a.postalCode).replace(/\D/g,"").slice(0,5) || null,
      phone: digits(n.telephone) || null,
      lat: isFinite(lat) ? lat : null,
      lng: isFinite(lng) ? lng : null,
      hours: hoursOf(n),
      via: "json-ld",
    };
  });
  /* one page often declares the same business twice (an Organization and
     a Store). Keep the richest copy of each. */
  const byKey = new Map<string, typeof rows[0]>();
  for (const r of rows) {
    const key = r.phone || `${r.street}|${r.zip}` || r.name.toLowerCase();
    const prev = byKey.get(key);
    const score = (x: typeof r) => (x.street?1:0)+(x.zip?1:0)+(x.lat?1:0)+Object.keys(x.hours).length;
    if (!prev || score(r) > score(prev)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

function toText(doc: string) {
  return doc
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ");
}

function fromHtml(doc: string) {
  const txt = toText(doc);
  let name = "";
  const og = doc.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i);
  if (og) name = og[1].trim();
  if (!name) {
    const t = doc.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) name = t[1].replace(/\s+/g," ").trim().split(/\s[|\-–—]\s/)[0].trim();
  }
  const addr = txt.match(new RegExp(
    "(\\d{2,6}\\s+[A-Za-z0-9.'\\- ]{2,40}\\s" + SUF + "\\.?)[\\s,]*" +
    "((?:(?:Ste|Suite|Unit|#)\\s*\\.?\\s*[A-Za-z0-9\\-]+)?)[\\s,]*" +
    "([A-Za-z .'\\-]{2,28}),\\s*([A-Z]{2})\\.?\\s+(\\d{5})", "i"));
  const ph = txt.match(/\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-](\d{4})/);
  if (!addr && !ph) return [];
  const sp = addr ? splitSuite(addr[1].replace(/\s+/g," ").trim()) : { street:"", suite:"" };
  const bare = addr ? (addr[2] || "").replace(/^(Ste|Suite|Unit|#)\s*\.?\s*/i, "").trim() : "";
  return [{
    name: name || null,
    street: sp.street || null,
    suite: sp.suite || bare || null,
    city: addr ? addr[3].trim() : null,
    state: addr ? addr[4].toUpperCase() : null,
    zip: addr ? addr[5] : null,
    phone: ph ? ph[1]+ph[2]+ph[3] : null,
    lat: null, lng: null, hours: {}, via: "html",
  }];
}

async function grab(url: string) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return { url, ok: false, rows: [], error: "private address refused" };
    }
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!res.ok) return { url, ok: false, rows: [], error: `HTTP ${res.status}` };
    const doc = await res.text();
    let rows = fromJsonLd(doc);
    if (!rows.length) rows = fromHtml(doc);
    return {
      url, ok: true, rows,
      error: rows.length ? undefined
        : "Nothing readable here - the page may draw its listings with script.",
    };
  } catch (e) {
    return { url, ok: false, rows: [], error: (e as Error).name === "AbortError" ? "timed out" : String(e) };
  } finally { clearTimeout(timer); }
}

serve(async (req) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  let urls: string[] = [];
  try { urls = ((await req.json())?.urls ?? []).filter((u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u)); }
  catch { return new Response(JSON.stringify({ error: "bad JSON" }), { status: 400, headers }); }

  if (!urls.length) return new Response(JSON.stringify({ error: "no urls" }), { status: 400, headers });

  const results = [];
  for (const u of urls.slice(0, MAX_URLS)) {
    results.push(await grab(u));
    await new Promise((r) => setTimeout(r, 400));   // be a polite visitor
  }
  return new Response(JSON.stringify({ results }), { headers });
});
