// Harbor eBook source plugin: ويكي مصدر العربية (Arabic Wikisource).
// Free-licensed / public-domain texts only. Uses the official MediaWiki API.
//
// Runs as the body of a function that receives `harbor`. Network only via
// harbor.http, HTML only via harbor.parseHtml.

const BASE = "https://ar.wikisource.org";
const API = BASE + "/w/api.php";
const PAGE_SIZE = 48;

// While testing, errors and counters are shown inside the app (in the description
// and chapter list). Set to false once everything works.
const DEBUG = true;

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
  return { doc: await harbor.parseHtml(p.text), categories: p.categories || [], htmlLength: p.text.length };
}


// Plain-text fallback that does not depend on HTML parsing (TextExtracts).
async function plainText(title) {
  const data = await api({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exlimit: "1",
    redirects: "1",
    titles: title,
  });
  const pages = (data.query && data.query.pages) || [];
  const page = Array.isArray(pages) ? pages[0] : Object.values(pages)[0];
  return page && page.extract ? String(page.extract).trim() : "";
}

function errText(e) {
  return String((e && e.message) || e || "unknown error");
}

function absUrl(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return undefined;
}

// Best-effort covers: the lead image of each page, when the page has one.
// Any failure is ignored (the book simply has no cover).
async function withCovers(list) {
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const data = await api({
        action: "query",
        prop: "pageimages",
        piprop: "thumbnail",
        pithumbsize: "300",
        pilimit: "50",
        titles: chunk.map((x) => x.id).join("|"),
      });
      const pages = (data.query && data.query.pages) || [];
      const byTitle = {};
      for (const pg of Array.isArray(pages) ? pages : Object.values(pages)) {
        if (pg && pg.title && pg.thumbnail && pg.thumbnail.source) byTitle[pg.title] = pg.thumbnail.source;
      }
      for (const x of chunk) if (byTitle[x.id]) x.cover = byTitle[x.id];
    } catch (e) {
      // ignore
    }
  }
  return list;
}

function rootTitle(title) {
  return String(title || "").split("/")[0].trim();
}

// Absolute link to the page on Wikisource (Harbor shows it as the "open in browser" button).
function pageUrl(title) {
  return BASE + "/wiki/" + encodeURIComponent(String(title).replace(/ /g, "_"));
}

function toSummary(title) {
  return { id: title, title, altTitles: [], genres: [], originalLanguage: "ar", siteUrl: pageUrl(title) };
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
  return withCovers(uniqueSummaries(hits.map((h) => h.title)));
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
  return withCovers(uniqueSummaries(slice.map((m) => m.title)));
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
    let fromCategory = [];
    if (offset === 0) {
      try {
        fromCategory = await categoryTitles(0);
      } catch (e) {
        fromCategory = [];
      }
    }
    let fromSearch = [];
    try {
      fromSearch = await searchTitles(DEFAULT_QUERY, offset);
    } catch (e) {
      if (!fromCategory.length) throw e;
    }
    const seen = new Set(fromCategory.map((x) => x.id));
    return fromCategory.concat(fromSearch.filter((x) => !seen.has(x.id)));
  },

  async search(query, offset, tagId) {
    return searchTitles(query, offset);
  },

  async detail(id) {
    let info = "";
    try {
      const parsed = await getParsed(id);
      if (!parsed) throw new Error("parse returned no text for: " + id);
      const { doc, categories } = parsed;

      const paragraphs = doc
        .querySelectorAll("p")
        .map((p) => p.text().trim())
        .filter((t) => t.length > 40);
      const anchors = doc.querySelectorAll("a");
      const subLinks = anchors.filter((a) => {
        const t = hrefToTitle(a.attr("href"));
        return t && t.startsWith(id + "/");
      }).length;
      info = "[debug] html=" + parsed.htmlLength + " p=" + paragraphs.length +
        " a=" + anchors.length + " sub=" + subLinks;

      let author;
      for (const a of anchors) {
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

      let cover;
      try {
        cover = (await withCovers([toSummary(id)]))[0].cover;
      } catch (e) {
        cover = undefined;
      }
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

      let description = paragraphs[0] ? paragraphs[0].slice(0, 600) : undefined;
      if (DEBUG) description = (description ? description + "\n\n" : "") + info;

      return { id, title: id, altTitles: [], description, author, originalLanguage: "ar", genres, cover, siteUrl: pageUrl(id) };
    } catch (e) {
      return {
        id,
        title: id,
        altTitles: [],
        description: DEBUG ? "[debug error] " + errText(e) : undefined,
        siteUrl: pageUrl(id),
        originalLanguage: "ar",
        genres: [],
      };
    }
  },

  // Chapters are the sub-pages linked from the book's main page, in page order.
  // If none are found, the page itself is a single chapter.
  async chapters(id) {
    const single = (note) => [{
      id,
      position: 0,
      title: DEBUG && note ? id + " " + note : id,
      pages: 0,
      language: "ar",
    }];
    try {
      const parsed = await getParsed(id);
      if (!parsed) return single("[debug: no parse text]");
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
      return out.length ? out : single("");
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
          ".mw-parser-output > p, .mw-parser-output > blockquote, .mw-parser-output > h2, .mw-parser-output > h3, .mw-parser-output > .poem",
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
    return GENRES.map((g) => ({ id: g.id, name: g.name, group: "النوع" }));
  },
};
