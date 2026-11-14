// Harbor eBook source plugin: مؤسسة هنداوي (Hindawi Foundation) on safahat.org.
// Free books published with the authors' permission or in the public domain.
//
// Runs as the body of a function that receives `harbor`. Network only via
// harbor.http, HTML only via harbor.parseHtml (which is ASYNC: always await it).

const BASE = "https://www.safahat.org";
const COVER_BASE = "https://downloads.hindawi.org/covers/304x406/";
const LIST_PAGE_SIZE = 20; // the site shows 20 books per page
const OUT_PAGE_SIZE = 48; // what Harbor asks for per call

// While testing, errors are shown inside the app (chapter list / text).
// Set to false once everything works.
const DEBUG = true;

// Category filters (slug = the site's own URL name).
const CATEGORIES = [
  { slug: "novels", name: "روايات" },
  { slug: "literature", name: "أدب" },
  { slug: "science.fiction", name: "خيال علمي" },
  { slug: "detective.fiction", name: "قصص بوليسية" },
  { slug: "children.stories", name: "قصص الأطفال" },
  { slug: "plays", name: "مسرحيات" },
  { slug: "poetry", name: "شعر" },
  { slug: "biographies", name: "سير الأعلام" },
  { slug: "travel.literature", name: "أدب رحلات" },
  { slug: "history", name: "تاريخ" },
  { slug: "philosophy", name: "فلسفة" },
  { slug: "psychology", name: "علم نفس" },
  { slug: "science", name: "علوم" },
  { slug: "politics", name: "سياسة" },
  { slug: "religions", name: "أديان" },
  { slug: "arts", name: "فنون" },
  { slug: "literary.criticism", name: "نقد أدبي" },
];
const DEFAULT_CATEGORY = "novels";

// ---------- networking: one request at a time, retries, caching ----------

const sleep = (ms) =>
  typeof setTimeout === "function" ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(() => sleep(250), () => sleep(250));
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
const docMemo = makeMemo(24);

function errText(e) {
  return String((e && e.message) || e || "unknown error");
}

async function fetchHtml(url, opts) {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await harbor.http(url, { responseType: "text", timeoutMs: 30000, ...(opts || {}) });
    if (res.ok) return res.body;
    status = res.status;
    if (status === 429 || status >= 500) {
      await sleep(1500 * Math.pow(2, attempt));
      continue;
    }
    break;
  }
  if (status === 403) throw new Error("http 403 (الموقع رفض الطلب، قد تكون حماية ضد الروبوتات)");
  throw new Error("http " + status + " for " + url);
}

function getDoc(url, opts, cacheKey) {
  return docMemo(cacheKey || url, () =>
    enqueue(async () => harbor.parseHtml(await fetchHtml(url, opts))),
  );
}

// ---------- helpers ----------

// Hindawi pages use Arabic-Indic digits in some places.
function toLatinDigits(s) {
  return String(s || "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

function bookIdFromHref(href) {
  const m = String(href || "").match(/\/books\/(\d+)\/?(?:[#?].*)?$/);
  return m ? m[1] : null;
}

function coverFor(id) {
  return COVER_BASE + id + ".jpg";
}

function cleanTitle(alt) {
  return String(alt || "").replace(/^\s*كتاب بعنوان\s*/u, "").replace(/\s+/g, " ").trim();
}

function clean(text) {
  return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function cardsToSummaries(doc) {
  const out = [];
  const seen = new Set();
  for (const li of doc.querySelectorAll("li.bookCover")) {
    const a = li.querySelector("a");
    const id = bookIdFromHref(a && a.attr("href"));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const img = li.querySelector("img");
    const title = cleanTitle(img && img.attr("alt"));
    if (!title) continue;
    out.push({
      id,
      title,
      altTitles: [],
      genres: [],
      cover: coverFor(id),
      originalLanguage: "ar",
      siteUrl: BASE + "/books/" + id + "/",
    });
  }
  return out;
}

function listUrl(slug, page) {
  return BASE + "/books/categories/" + slug + "/" + page + "/";
}

// Harbor asks for OUT_PAGE_SIZE items starting at `offset`; the site pages by 20,
// so fetch the pages that cover that window and slice.
async function browseCategory(slug, offset) {
  const firstPage = Math.floor(offset / LIST_PAGE_SIZE) + 1;
  const skip = offset % LIST_PAGE_SIZE;
  const need = skip + OUT_PAGE_SIZE;
  const pagesNeeded = Math.ceil(need / LIST_PAGE_SIZE);
  let items = [];
  for (let i = 0; i < pagesNeeded; i++) {
    let doc;
    try {
      doc = await getDoc(listUrl(slug, firstPage + i));
    } catch (e) {
      if (i === 0) throw e;
      break;
    }
    const got = cardsToSummaries(doc);
    if (!got.length) break;
    items = items.concat(got);
    if (got.length < LIST_PAGE_SIZE) break;
  }
  return items.slice(skip, skip + OUT_PAGE_SIZE);
}

// Site search is a POST form (keyword). Best effort: the results page is expected
// to reuse the same book cards.
async function searchSite(query) {
  const url = BASE + "/layout/search/";
  const body = "keyword=" + encodeURIComponent(query);
  const doc = await getDoc(
    url,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    "search:" + query,
  );
  return cardsToSummaries(doc);
}

// Fallback search: filter the novels catalog by title (page by page, cached).
async function searchCatalog(query, slug) {
  const q = clean(query);
  if (!q) return [];
  const words = q.split(" ").filter(Boolean);
  const hits = [];
  for (let page = 1; page <= 40; page++) {
    let doc;
    try {
      doc = await getDoc(listUrl(slug, page));
    } catch (e) {
      break;
    }
    const got = cardsToSummaries(doc);
    if (!got.length) break;
    for (const b of got) if (words.every((w) => b.title.includes(w))) hits.push(b);
    if (got.length < LIST_PAGE_SIZE) break;
  }
  return hits;
}

const plugin = {
  // id must match the manifest id in repo.json.
  id: "hindawi-ar",
  name: "مؤسسة هنداوي",

  async popular(offset, tagId) {
    const slug = tagId && tagId.startsWith("cat:") ? tagId.slice(4) : DEFAULT_CATEGORY;
    return browseCategory(slug, offset);
  },

  async search(query, offset, tagId) {
    if (offset > 0) return [];
    let results = [];
    try {
      results = await searchSite(query);
    } catch (e) {
      results = [];
    }
    if (!results.length) {
      const slug = tagId && tagId.startsWith("cat:") ? tagId.slice(4) : DEFAULT_CATEGORY;
      results = await searchCatalog(query, slug);
    }
    return results.slice(0, OUT_PAGE_SIZE);
  },

  async detail(id) {
    try {
      const doc = await getDoc(BASE + "/books/" + id + "/");
      const root = doc.querySelector("article.book");
      if (!root) throw new Error("لم أجد بطاقة الكتاب في الصفحة");

      const title = clean(root.querySelector("h2") && root.querySelector("h2").text());
      const authors = root
        .querySelectorAll(".author a")
        .map((a) => clean(a.text()))
        .filter(Boolean);
      const genres = root
        .querySelectorAll(".tags li a")
        .map((a) => clean(a.text()))
        .filter(Boolean);
      const paragraphs = root
        .querySelectorAll(".content p")
        .map((p) => clean(p.text()))
        .filter(Boolean);

      const altTitles = [];
      const en = doc.querySelector("#book_BookTitleE");
      const enTitle = en && clean(en.attr("value"));
      if (enTitle) altTitles.push(enTitle);

      return {
        id,
        title: title || id,
        altTitles,
        author: authors[0],
        authors: authors.length ? authors : undefined,
        description: paragraphs.length ? paragraphs.join("\n\n").slice(0, 1500) : undefined,
        genres,
        cover: coverFor(id),
        originalLanguage: "ar",
        siteUrl: BASE + "/books/" + id + "/",
      };
    } catch (e) {
      return {
        id,
        title: id,
        altTitles: [],
        genres: [],
        cover: coverFor(id),
        description: DEBUG ? "[debug error] " + errText(e) : undefined,
        siteUrl: BASE + "/books/" + id + "/",
      };
    }
  },

  // Chapters = the entries of the book's own table of contents, in order.
  // chapter id = "<bookId>/<section>", e.g. "52627375/0.1" or "52627375/3".
  async chapters(id) {
    const single = (note) => [{
      id: id + "/1",
      position: 0,
      title: DEBUG && note ? "القراءة " + note : "القراءة",
    }];
    try {
      const doc = await getDoc(BASE + "/books/" + id + "/");
      const out = [];
      const seen = new Set();
      for (const a of doc.querySelectorAll(".bookIndex a")) {
        const m = String(a.attr("href") || "").match(/\/books\/(\d+)\/([0-9.]+)\/?$/);
        if (!m || m[1] !== String(id)) continue;
        const cid = m[1] + "/" + m[2];
        if (seen.has(cid)) continue;
        seen.add(cid);
        out.push({
          id: cid,
          position: out.length,
          title: clean(a.text()) || "قسم " + m[2],
        });
      }
      return out.length ? out : single("");
    } catch (e) {
      return single("[debug error: " + errText(e) + "]");
    }
  },

  async content(chapterId) {
    try {
      const doc = await getDoc(BASE + "/books/" + chapterId + "/");
      const root = doc.querySelector("article.chapterContent");
      if (!root) throw new Error("لم أجد نص القسم في الصفحة");
      // DOM order is kept; wrappers that contain other blocks are skipped so no
      // text appears twice. Footnotes come last, as on the site.
      const nodes = root.querySelectorAll(
        "h1, h2, h3, h4, p, .paragraph-block, blockquote, li, .footnote",
      );
      const blocks = [];
      for (const n of nodes) {
        const isWrapper = n.querySelector("p, .paragraph-block, blockquote, li");
        if (isWrapper) continue;
        const t = clean(n.text());
        if (t) blocks.push(t);
      }
      const text = blocks.join("\n\n");
      if (!text) throw new Error("نص القسم فارغ");
      return text;
    } catch (e) {
      return DEBUG ? "[debug] تعذّر جلب النص: " + errText(e) : "";
    }
  },

  async tags() {
    return CATEGORIES.map((c) => ({ id: "cat:" + c.slug, name: c.name, group: "التصنيف" }));
  },
};
