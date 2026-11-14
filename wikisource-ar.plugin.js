// Harbor eBook source plugin: ويكي مصدر العربية (Arabic Wikisource).
// Free-licensed / public-domain texts only. Uses the official MediaWiki API.
//
// Runs as the body of a function that receives `harbor`. Network only via
// harbor.http, HTML only via harbor.parseHtml (which is ASYNC: always await it).

const BASE = "https://ar.wikisource.org";
const API = BASE + "/w/api.php";
const PAGE_SIZE = 48;
const UA = "HarborArabicWikisourcePlugin/1.1 (personal reading plugin)";

// While testing, error messages are shown inside the app (chapter list / text).
// Set to false once everything works.
const DEBUG = true;

// Default "popular" list: these well-known works (taken from the Wikisource home
// page) come first when they exist, then the novels category, then a keyword search.
const FEATURED = [
  "ألف ليلة وليلة",
  "الأجنحة المتكسرة",
  "حي بن يقظان",
  "الزير سالم",
  "مقامات بديع الزمان الهمذاني",
  "مقامات الحريري",
  "رسالة التوابع والزوابع",
  "العقد الفريد",
  "المعلقات",
  "مقدمة ابن خلدون",
  "تاريخ الطبري",
  "البداية والنهاية",
  "مفاتيح العلوم",
  "لسان العرب",
  "كتاب سيبويه",
  "أساس البلاغة",
];
const POPULAR_CATEGORY = "تصنيف:روايات";
const DEFAULT_QUERY = "رواية";

// Type filters (keyword searches in page titles).
const GENRES = [
  { id: "q:intitle:رواية", name: "روايات" },
  { id: "q:intitle:قصص", name: "قصص" },
  { id: "q:intitle:ديوان", name: "دواوين شعر" },
  { id: "q:intitle:مقامات", name: "مقامات" },
  { id: "q:intitle:مسرحية", name: "مسرحيات" },
  { id: "q:intitle:سيرة", name: "سير وتراجم" },
  { id: "q:intitle:تاريخ", name: "تاريخ" },
  { id: "q:intitle:تفسير", name: "تفسير" },
  { id: "q:intitle:رسالة", name: "رسائل" },
];

// ---------- networking: one request at a time, retries on 429, caching ----------

const sleep = (ms) =>
  typeof setTimeout === "function" ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(() => sleep(200), () => sleep(200));
  return run;
}

function makeMemo(limit) {
  const map = new Map();
  return (key, fn) => {
    if (map.has(key)) return map.get(key);
    const p = Promise.resolve().then(fn);
    map.set(key, p);
    p.catch(() => map.delete(key));
    if (map.size > limit) map.delete(map.keys().next().value);
    return p;
  };
}
const apiMemo = makeMemo(60);
const parseMemo = makeMemo(8);

async function fetchWithRetry(url) {
  let status = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await harbor.http(url, {
      responseType: "text",
      timeoutMs: 40000,
      headers: { "Api-User-Agent": UA },
    });
    if (res.ok) return res.body;
    status = res.status;
    if (status === 429 || status >= 500) {
      const h = res.headers || {};
      const ra = Number(h["retry-after"] || h["Retry-After"]) || 0;
      await sleep(Math.min(10000, ra ? ra * 1000 : 1500 * Math.pow(2, attempt)));
      continue;
    }
    break;
  }
  throw new Error("http " + status + " from Wikisource API");
}

function api(params, cache = true) {
  const qs = new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params }).toString();
  const run = () =>
    enqueue(async () => {
      const body = await fetchWithRetry(API + "?" + qs);
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        throw new Error("Wikisource API returned invalid JSON");
      }
      if (data && data.error) throw new Error("Wikisource API: " + (data.error.info || data.error.code));
      return data;
    });
  return cache ? apiMemo(qs, run) : run();
}

function errText(e) {
  return String((e && e.message) || e || "unknown error");
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? Object.values(v) : [];
}

// ---------- titles, summaries, covers ----------

function rootTitle(title) {
  return String(title || "").split("/")[0].trim();
}

function pageUrl(title) {
  return BASE + "/wiki/" + encodeURIComponent(String(title).replace(/ /g, "_"));
}

function toSummary(title) {
  return { id: title, title, altTitles: [], genres: [], originalLanguage: "ar", siteUrl: pageUrl(title) };
}

function uniqueRoots(titles) {
  const seen = new Set();
  const out = [];
  for (const t of titles) {
    const root = rootTitle(t);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

function absUrl(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return undefined;
}

// Cover (lead image), Wikidata id and categories (as genres) for a list of
// summaries, in as few requests as possible. Best effort: failures are ignored.
async function withMeta(list) {
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const data = await api({
        action: "query",
        prop: "pageimages|pageprops|categories",
        piprop: "thumbnail",
        pithumbsize: "300",
        pilimit: "50",
        ppprop: "wikibase_item",
        cllimit: "max",
        clshow: "!hidden",
        titles: chunk.map((x) => x.id).join("|"),
      });
      const byTitle = {};
      for (const pg of asArray(data.query && data.query.pages)) {
        if (pg && pg.title) byTitle[pg.title] = pg;
      }
      for (const x of chunk) {
        const pg = byTitle[x.id];
        if (!pg) continue;
        if (pg.thumbnail && pg.thumbnail.source) x.cover = pg.thumbnail.source;
        const q = pg.pageprops && pg.pageprops.wikibase_item;
        if (q) x.wikidataId = q;
        const cats = asArray(pg.categories)
          .map((c) => String(c.title || "").replace(/^[^:]+:/, "").replace(/_/g, " ").trim())
          .filter(Boolean);
        if (cats.length) x.genres = cats.slice(0, 6);
      }
    } catch (e) {
      // ignore
    }
  }
  return list;
}

// Keep only titles that really exist (following redirects).
async function resolveTitles(titles) {
  const out = [];
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const data = await api({ action: "query", titles: chunk.join("|"), redirects: "1" });
    const q = data.query || {};
    const existing = new Set(
      asArray(q.pages).filter((p) => p && !p.missing && !p.invalid).map((p) => p.title),
    );
    const map = {};
    for (const n of asArray(q.normalized)) map[n.from] = n.to;
    for (const r of asArray(q.redirects)) map[r.from] = r.to;
    for (const t of chunk) {
      let f = t;
      for (let k = 0; k < 3 && map[f]; k++) f = map[f];
      if (existing.has(f)) out.push(f);
    }
  }
  return out;
}

// ---------- listing ----------

async function searchRaw(query, offset) {
  const data = await api({
    action: "query",
    list: "search",
    srsearch: query,
    srnamespace: "0",
    srlimit: String(PAGE_SIZE),
    sroffset: String(offset || 0),
    srprop: "",
  });
  return asArray(data.query && data.query.search).map((h) => h.title);
}

async function categoryRaw(category) {
  const data = await api({
    action: "query",
    list: "categorymembers",
    cmtitle: category,
    cmtype: "page",
    cmnamespace: "0",
    cmlimit: "500",
  });
  return asArray(data.query && data.query.categorymembers)
    .map((m) => m.title)
    .filter((t) => t && !t.includes("/"));
}

let popularBasePromise = null;
function popularBase() {
  if (!popularBasePromise) {
    popularBasePromise = (async () => {
      const titles = [];
      try { titles.push(...(await resolveTitles(FEATURED))); } catch (e) { /* ignore */ }
      try { titles.push(...(await categoryRaw(POPULAR_CATEGORY))); } catch (e) { /* ignore */ }
      try { titles.push(...(await searchRaw(DEFAULT_QUERY, 0))); } catch (e) { /* ignore */ }
      const roots = uniqueRoots(titles);
      if (!roots.length) {
        popularBasePromise = null;
        throw new Error("تعذّر جلب القائمة (ربما حدّ الطلبات). أعد المحاولة بعد قليل.");
      }
      return roots;
    })();
    popularBasePromise.catch(() => { popularBasePromise = null; });
  }
  return popularBasePromise;
}

async function listFrom(titles) {
  return withMeta(uniqueRoots(titles).map(toSummary));
}

// ---------- page parsing ----------

async function getParsed(title) {
  return parseMemo(title, async () => {
    const data = await api(
      {
        action: "parse",
        page: title,
        prop: "text|categories",
        redirects: "1",
        disableeditsection: "1",
        disablelimitreport: "1",
      },
      false,
    );
    const p = data.parse;
    if (!p || typeof p.text !== "string") return null;
    return { doc: await harbor.parseHtml(p.text), categories: p.categories || [] };
  });
}

async function plainText(title) {
  const data = await api({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exlimit: "1",
    redirects: "1",
    titles: title,
  });
  const pages = asArray(data.query && data.query.pages);
  const page = pages[0];
  return page && page.extract ? String(page.extract).trim() : "";
}

// Decode an internal wiki link like "/wiki/%D9%83.../%D9%81..." to a page title.
function hrefToTitle(href) {
  if (!href || !href.startsWith("/wiki/")) return null;
  try {
    return decodeURIComponent(href.slice(6)).split("#")[0].replace(/_/g, " ").trim();
  } catch (e) {
    return null;
  }
}

async function subpages(id) {
  const data = await api({
    action: "query",
    list: "allpages",
    apprefix: id + "/",
    apnamespace: "0",
    aplimit: "500",
  });
  const titles = asArray(data.query && data.query.allpages).map((p) => p.title);
  titles.sort((a, b) => a.localeCompare(b, "ar", { numeric: true }));
  return titles;
}

let categoriesPromise = null;
async function topCategories() {
  if (!categoriesPromise) {
    categoriesPromise = (async () => {
      const data = await api({
        action: "query",
        list: "allcategories",
        acmin: "15",
        aclimit: "500",
        acprop: "size",
      });
      const skip = /ويكي|صفحات|قوالب|قالب|ملفات|ملف|فهرس|مراجعة|صيانة|بوابة|مستخدم|تحويل|وحدات|صور|مقالات|مشاريع/;
      return asArray(data.query && data.query.allcategories)
        .map((c) => ({ name: String(c.category || "").replace(/_/g, " ").trim(), pages: c.pages || c.size || 0 }))
        .filter((c) => c.name && !skip.test(c.name) && c.pages >= 15)
        .sort((a, b) => b.pages - a.pages)
        .slice(0, 40);
    })();
    categoriesPromise.catch(() => { categoriesPromise = null; });
  }
  return categoriesPromise;
}

const plugin = {
  // id must match the manifest id in repo.json.
  id: "wikisource-ar",
  name: "ويكي مصدر العربية",

  async popular(offset, tagId) {
    if (tagId && tagId.startsWith("q:")) {
      return listFrom(await searchRaw(tagId.slice(2), offset));
    }
    if (tagId && tagId.startsWith("cat:")) {
      const all = await categoryRaw("تصنيف:" + tagId.slice(4));
      return listFrom(all.slice(offset, offset + PAGE_SIZE));
    }
    const base = await popularBase();
    if (offset < base.length) return listFrom(base.slice(offset, offset + PAGE_SIZE));
    return listFrom(await searchRaw(DEFAULT_QUERY, offset));
  },

  async search(query, offset, tagId) {
    return listFrom(await searchRaw(query, offset));
  },

  async detail(id) {
    try {
      const [parsed, meta] = await Promise.all([getParsed(id), withMeta([toSummary(id)])]);
      const base = meta[0];
      if (!parsed) throw new Error("parse returned no text for: " + id);
      const { doc } = parsed;

      const paragraphs = doc
        .querySelectorAll("p")
        .map((p) => p.text().trim())
        .filter((t) => t.length > 40);

      let author;
      for (const a of doc.querySelectorAll("a")) {
        const t = hrefToTitle(a.attr("href"));
        if (t && t.startsWith("مؤلف:")) {
          author = a.text().trim() || t.slice(5);
          break;
        }
      }

      let cover = base.cover;
      if (!cover) {
        for (const img of doc.querySelectorAll("img")) {
          const src = img.attr("src") || "";
          const w = Number(img.attr("width")) || 0;
          if (!/upload\.wikimedia\.org/.test(src)) continue;
          if (/icon|logo|ambox|information|oojs|edit-|\.svg/i.test(src)) continue;
          if (w && w < 100) continue;
          cover = absUrl(src);
          break;
        }
      }

      return {
        ...base,
        description: paragraphs[0] ? paragraphs[0].slice(0, 600) : undefined,
        author,
        cover,
      };
    } catch (e) {
      return { ...toSummary(id), description: DEBUG ? "[debug error] " + errText(e) : undefined };
    }
  },

  // Chapters = the sub-pages linked from the book's main page, in page order.
  // Fallbacks: all sub-pages by prefix; else the page itself as a single chapter.
  async chapters(id) {
    const single = (note) => [{
      id,
      position: 0,
      title: DEBUG && note ? id + " " + note : id,
      pages: 0,
      language: "ar",
    }];
    try {
      const prefix = id + "/";
      let titles = [];
      const parsed = await getParsed(id);
      if (parsed) {
        const seen = new Set();
        for (const a of parsed.doc.querySelectorAll("a")) {
          const t = hrefToTitle(a.attr("href"));
          if (!t || !t.startsWith(prefix) || seen.has(t)) continue;
          seen.add(t);
          titles.push(t);
        }
      }
      if (!titles.length) {
        try { titles = await subpages(id); } catch (e) { titles = []; }
      }
      if (!titles.length) return single("");
      return titles.map((t, position) => ({
        id: t,
        position,
        title: t.slice(prefix.length).replace(/\//g, " › "),
        pages: 0,
        language: "ar",
      }));
    } catch (e) {
      return single("[debug error: " + errText(e) + "]");
    }
  },

  async content(chapterId) {
    let text = "";
    let problem = "";
    try {
      const parsed = await getParsed(chapterId);
      if (parsed) {
        // Keep DOM order. Never sort or deduplicate prose.
        const blocks = parsed.doc.querySelectorAll(
          ".mw-parser-output > p, .mw-parser-output > blockquote, .mw-parser-output > h2, .mw-parser-output > h3, .mw-parser-output > h4, .mw-parser-output > .poem, .mw-parser-output > dl, .mw-parser-output > ul, .mw-parser-output > ol",
        );
        text = blocks.map((n) => n.text().trim()).filter(Boolean).join("\n\n");
        if (!text) {
          const root = parsed.doc.querySelector(".mw-parser-output");
          text = root ? root.text().trim() : "";
        }
      }
    } catch (e) {
      problem = errText(e);
    }
    if (!text) {
      try {
        text = await plainText(chapterId);
      } catch (e) {
        problem = problem || errText(e);
      }
    }
    if (!text) {
      return DEBUG
        ? "[debug] لم يُعثر على نص لهذه الصفحة. " + (problem ? "الخطأ: " + problem : "الصفحة فارغة أو تعتمد على صور ممسوحة ضوئياً.")
        : "";
    }
    return text;
  },

  async tags() {
    const out = GENRES.map((g) => ({ id: g.id, name: g.name, group: "النوع" }));
    try {
      for (const c of await topCategories()) out.push({ id: "cat:" + c.name, name: c.name, group: "التصنيف" });
    } catch (e) {
      // keep the static genres only
    }
    return out;
  },
};
