// Harbor eBook source plugin: ويكي مصدر العربية (Arabic Wikisource).
// Free-licensed / public-domain texts only. Uses the official MediaWiki API.
//
// Runs as the body of a function that receives `harbor`. Network only via
// harbor.http, HTML only via harbor.parseHtml.

const BASE = "https://ar.wikisource.org";
const API = BASE + "/w/api.php";
const PAGE_SIZE = 48;

// Editable: category used for the default "popular" list. If it is empty or does
// not exist, the plugin falls back to a plain keyword search (DEFAULT_QUERY).
const POPULAR_CATEGORY = "تصنيف:روايات";
const DEFAULT_QUERY = "رواية";

// Genre filters. Each one runs a keyword search (id format: "q:<keyword>").
const GENRES = [
  { id: "q:رواية", name: "روايات" },
  { id: "q:مجموعة قصصية", name: "قصص قصيرة" },
  { id: "q:ديوان", name: "دواوين شعر" },
  { id: "q:مسرحية", name: "مسرحيات" },
  { id: "q:مقامات", name: "مقامات" },
  { id: "q:سيرة", name: "سير وتراجم" },
];

async function api(params) {
  const qs = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  const res = await harbor.http(API + "?" + qs.toString(), { responseType: "text" });
  if (!res.ok) throw new Error("http " + res.status + " from Wikisource API");
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    throw new Error("Wikisource API returned invalid JSON");
  }
  if (data && data.error) throw new Error("Wikisource API: " + (data.error.info || data.error.code));
  return data;
}

async function getParsed(title) {
  const data = await api({
    action: "parse",
    page: title,
    prop: "text|categories",
    redirects: "1",
    disableeditsection: "1",
    disablelimitreport: "1",
  });
  const p = data.parse;
  if (!p || typeof p.text !== "string") return null;
  return { doc: harbor.parseHtml(p.text), categories: p.categories || [] };
}

function rootTitle(title) {
  return String(title || "").split("/")[0].trim();
}

function toSummary(title) {
  return { id: title, title, altTitles: [], genres: [] };
}

function uniqueSummaries(titles) {
  const seen = new Set();
  const out = [];
  for (const t of titles) {
    const root = rootTitle(t);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    out.push(toSummary(root));
  }
  return out;
}

async function searchTitles(query, offset) {
  const data = await api({
    action: "query",
    list: "search",
    srsearch: query,
    srnamespace: "0",
    srlimit: String(PAGE_SIZE),
    sroffset: String(offset || 0),
    srprop: "",
  });
  const hits = (data.query && data.query.search) || [];
  return uniqueSummaries(hits.map((h) => h.title));
}

async function categoryTitles(offset) {
  const data = await api({
    action: "query",
    list: "categorymembers",
    cmtitle: POPULAR_CATEGORY,
    cmtype: "page",
    cmnamespace: "0",
    cmlimit: "500",
  });
  const members = (data.query && data.query.categorymembers) || [];
  const slice = members.slice(offset, offset + PAGE_SIZE);
  return uniqueSummaries(slice.map((m) => m.title));
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

const plugin = {
  // id must match the manifest id in repo.json.
  id: "wikisource-ar",
  name: "ويكي مصدر العربية",

  async popular(offset, tagId) {
    if (tagId && tagId.startsWith("q:")) {
      return searchTitles(tagId.slice(2), offset);
    }
    try {
      const fromCategory = await categoryTitles(offset);
      if (fromCategory.length || offset > 0) return fromCategory;
    } catch (e) {
      // fall through to the keyword search
    }
    return searchTitles(DEFAULT_QUERY, offset);
  },

  async search(query, offset, tagId) {
    return searchTitles(query, offset);
  },

  async detail(id) {
    const parsed = await getParsed(id);
    if (!parsed) return null;
    const { doc, categories } = parsed;

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

    const genres = categories
      .filter((c) => !c.hidden)
      .map((c) => String(c.category || "").replace(/_/g, " ").trim())
      .filter(Boolean)
      .slice(0, 6);

    return {
      id,
      title: id,
      altTitles: [],
      description: paragraphs[0] ? paragraphs[0].slice(0, 600) : undefined,
      author,
      originalLanguage: "ar",
      genres,
    };
  },

  // Chapters are the sub-pages linked from the book's main page, in the order
  // they appear on that page. If there are none, the page itself is one chapter.
  async chapters(id) {
    const parsed = await getParsed(id);
    if (!parsed) return [];
    const prefix = id + "/";
    const seen = new Set();
    const out = [];
    for (const a of parsed.doc.querySelectorAll("a")) {
      const t = hrefToTitle(a.attr("href"));
      if (!t || !t.startsWith(prefix) || seen.has(t)) continue;
      seen.add(t);
      out.push({
        id: t,
        position: out.length,
        title: t.slice(prefix.length).replace(/\//g, " › "),
        pages: 0,
        language: "ar",
      });
    }
    if (!out.length) {
      return [{ id, position: 0, title: id, pages: 0, language: "ar" }];
    }
    return out;
  },

  async content(chapterId) {
    const parsed = await getParsed(chapterId);
    if (!parsed) return "";
    const doc = parsed.doc;
    // Keep DOM order. Never sort or deduplicate prose.
    let blocks = doc.querySelectorAll(
      ".mw-parser-output > p, .mw-parser-output > blockquote, .mw-parser-output > h2, .mw-parser-output > h3, .mw-parser-output > .poem",
    );
    let text = blocks.map((n) => n.text().trim()).filter(Boolean).join("\n\n");
    if (!text) {
      const root = doc.querySelector(".mw-parser-output");
      text = root ? root.text().trim() : "";
    }
    return text;
  },

  async tags() {
    return GENRES.map((g) => ({ id: g.id, name: g.name, group: "النوع" }));
  },
};
