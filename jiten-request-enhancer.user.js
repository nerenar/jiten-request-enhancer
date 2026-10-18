// ==UserScript==
// @name         Jiten Request Enhancer
// @namespace    https://github.com/nerenar/jiten-request-enhancer
// @license      MIT
// @version      0.1.0
// @description  Autofill Japanese titles from database URLs and search VNDB/AniList/MyAnimeList/Syosetu from the Jiten request form.
// @match        https://jiten.moe/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @connect      graphql.anilist.co
// @connect      api.vndb.org
// @connect      api.tenrai.org
// @connect      api.syosetu.com
// @downloadURL  https://raw.githubusercontent.com/nerenar/jiten-request-enhancer/main/jiten-request-enhancer.user.js
// @updateURL    https://raw.githubusercontent.com/nerenar/jiten-request-enhancer/main/jiten-request-enhancer.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Storage and HTTP (userscript APIs, with plain browser fallbacks)
  // ---------------------------------------------------------------------------

  // Tampermonkey and Violentmonkey have the GM_* functions; Greasemonkey 4 only has the promise-based GM.* ones.
  const GM4 = typeof GM === 'object' && GM ? GM : null;
  const gmXhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : GM4?.xmlHttpRequest ? (details) => GM4.xmlHttpRequest(details) : null;
  const gmMenu = typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand
    : GM4?.registerMenuCommand ? (name, fn) => GM4.registerMenuCommand(name, fn) : null;

  // Settings are read synchronously, so their stored values are loaded once at startup.
  const SETTING_KEYS = ['searchAsYouType', 'showAdultCovers'];
  const settingValues = {};
  const settingsReady = (async () => {
    for (const key of SETTING_KEYS) {
      try {
        if (typeof GM_getValue === 'function') settingValues[key] = GM_getValue(key);
        else if (GM4?.getValue) settingValues[key] = await GM4.getValue(key);
        else {
          const v = localStorage.getItem('jre:' + key);
          if (v !== null) settingValues[key] = JSON.parse(v);
        }
      } catch { /* ignore */ }
    }
  })();

  const settings = {
    get(key, def) {
      return settingValues[key] === undefined ? def : settingValues[key];
    },
    set(key, value) {
      settingValues[key] = value;
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else if (GM4?.setValue) GM4.setValue(key, value);
        else localStorage.setItem('jre:' + key, JSON.stringify(value));
      } catch { /* ignore */ }
    },
  };

  // Minimum gap between calls to one host, and who it is in messages.
  const HOSTS = {
    'graphql.anilist.co': { name: 'AniList', gap: 700 },
    'api.vndb.org': { name: 'VNDB', gap: 1000 },
    'api.tenrai.org': { name: 'MyAnimeList', gap: 400 },
    'api.syosetu.com': { name: 'Syosetu', gap: 1000 },
  };
  const MAX_RETRY_WAIT = 10000;
  const hostState = {}; // host -> { next: time the next call may start, pausedUntil }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
    });
  }

  function rateLimitError(host, until) {
    const secs = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    return new Error(`${HOSTS[host]?.name || host} is rate-limiting, try again in ${secs}s.`);
  }

  // Waits for this host's next free slot; queued calls that get aborted never go out.
  async function throttle(host, signal) {
    const st = hostState[host] ||= { next: 0, pausedUntil: 0 };
    if (st.pausedUntil > Date.now()) throw rateLimitError(host, st.pausedUntil);
    const start = Math.max(Date.now(), st.next);
    st.next = start + (HOSTS[host]?.gap || 0);
    if (start > Date.now()) await sleep(start - Date.now(), signal);
  }

  function retryAfterMs(value) {
    if (!value) return 5000;
    const secs = Number(value);
    if (!Number.isNaN(secs)) return secs * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? 5000 : Math.max(0, date - Date.now());
  }

  function send({ method, url, headers, body, signal }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const host = new URL(url).host;
      if (gmXhr) {
        const req = gmXhr({
          method, url, headers, data: body, timeout: 15000,
          anonymous: true, // no cookies for the API's site are sent along
          onload: (r) => resolve({
            status: r.status, text: r.responseText,
            retryAfter: /^retry-after:\s*(.+)$/im.exec(r.responseHeaders || '')?.[1]?.trim(),
          }),
          onerror: () => reject(new Error(`Couldn't reach ${HOSTS[host]?.name || host}.`)),
          ontimeout: () => reject(new Error(`${HOSTS[host]?.name || host} took too long to answer.`)),
        });
        signal?.addEventListener('abort', () => { try { req?.abort?.(); } catch { /* ignore */ } reject(abortError()); });
      } else {
        fetch(url, { method, headers, body, signal, credentials: 'omit' })
          .then(async (r) => resolve({ status: r.status, text: await r.text(), retryAfter: r.headers.get('retry-after') }))
          .catch(reject);
      }
    });
  }

  // On 429: wait as long as the host asks (up to MAX_RETRY_WAIT) and retry once;
  // after that the host is paused and further calls fail fast with the wait time.
  async function request({ method = 'GET', url, headers = {}, body, responseType = 'json', signal }) {
    const host = new URL(url).host;
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      await throttle(host, signal);
      res = await send({ method, url, headers, body, signal });
      if (res.status !== 429) break;
      const wait = retryAfterMs(res.retryAfter);
      if (attempt === 1 || wait > MAX_RETRY_WAIT) {
        const st = hostState[host];
        st.pausedUntil = Date.now() + Math.max(wait, 5000);
        throw rateLimitError(host, st.pausedUntil);
      }
      await sleep(wait, signal);
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`${HOSTS[host]?.name || host} returned an error (${res.status}).`);
    if (responseType === 'text') return res.text;
    try { return JSON.parse(res.text); } catch { throw new Error(`${HOSTS[host]?.name || host} sent an unreadable answer.`); }
  }

  function abortError() {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }

  const postJson = (url, payload, opts = {}) => request({
    method: 'POST', url, body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) },
    signal: opts.signal,
  });

  // ---------------------------------------------------------------------------
  // Media types (Jiten enum labels) and provider priority
  // ---------------------------------------------------------------------------

  const MEDIA = {
    ANIME: 'Anime', AUDIO: 'Audio', DRAMA: 'Drama', MANGA: 'Manga', MOVIE: 'Movie',
    NONFICTION: 'Non-Fiction', NOVEL: 'Novel', VIDEOGAME: 'Video Game',
    VN: 'Visual Novel', WEBNOVEL: 'Web Novel', YOUTUBE: 'YouTube',
  };

  // Mirrors Jiten's metadata fetch order (AdminController / add-media.vue).
  const PRIORITY = {
    [MEDIA.ANIME]: ['anilist', 'mal'],
    [MEDIA.MANGA]: ['anilist', 'mal'],
    [MEDIA.NOVEL]: ['anilist', 'mal'],
    [MEDIA.VN]: ['vndb'],
    [MEDIA.WEBNOVEL]: ['syosetu'],
  };

  // A source's results are hidden when the source named here has the same entry.
  const COVERED_BY = { mal: 'anilist' };

  function withoutCovered(results, coveringResults) {
    const seen = new Set(coveringResults.map((r) => r.malId).filter(Boolean));
    return results.filter((r) => !r.malId || !seen.has(r.malId));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const JP_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
  const hasJapanese = (s) => !!s && JP_RE.test(s);
  // Kana only occur in Japanese, so they tell a Japanese title apart from a Chinese one.
  const KANA_RE = /[\u3040-\u30ff\uff66-\uff9f]/;
  const hasKana = (s) => !!s && KANA_RE.test(s);
  const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
  const yearOf = (s) => { const m = /\b(\d{4})\b/.exec(s || ''); return m ? +m[1] : null; };

  function makeResult(r) {
    const out = {
      source: r.source,
      url: r.url,
      title: clean(r.title),
      jpTitle: clean(r.jpTitle) || null,
      romaji: clean(r.romaji) || null,
      english: clean(r.english) || null,
      year: r.year || null,
      format: clean(r.format) || null,
      image: r.image || null,
      adultCover: !!r.adultCover, // hidden unless "Show adult covers" is on
      mediaType: r.mediaType || null, // Jiten media type this entry implies
      malId: r.malId || null,         // MyAnimeList id, used to spot duplicates
      details: (r.details || []).map(clean).filter(Boolean), // counts, studio, author…
    };
    out.fillTitle = out.jpTitle || out.title || out.romaji || out.english;
    return out;
  }

  function hostIs(u, domain) {
    return u.hostname === domain || u.hostname.endsWith('.' + domain);
  }

  function toUrl(raw) {
    try {
      const s = clean(raw);
      return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    } catch { return null; }
  }

  // ---------------------------------------------------------------------------
  // Providers
  // ---------------------------------------------------------------------------

  const providers = {};

  // --- AniList ---------------------------------------------------------------
  const ANILIST_FIELDS = 'id idMal siteUrl type format countryOfOrigin synonyms episodes chapters volumes startDate{year} title{native romaji english} '
    + 'coverImage{medium} isAdult studios(isMain:true){nodes{name}} staff(perPage:3, sort:[RELEVANCE]){edges{role node{name{full native}}}}';

  // count(12, 'ep') -> '12 eps', count(1, 'ep') -> '1 ep'
  const count = (n, unit, plural = unit + 's') => (n ? `${n} ${n === 1 ? unit : plural}` : null);

  const ANILIST_FORMAT = {
    TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA',
    MANGA: 'Manga', NOVEL: 'Novel', ONE_SHOT: 'One-shot',
  };

  // Japanese works use their native title. For Korean, Chinese and other works the
  // Japanese release title, when AniList knows it, is one of the synonyms.
  function anilistJapaneseTitle(m) {
    const native = m.title?.native;
    if (m.countryOfOrigin === 'JP' || !m.countryOfOrigin) return hasJapanese(native) ? native : null;
    if (hasKana(native)) return native;
    return (m.synonyms || []).find(hasKana) || null;
  }

  function anilistDetails(m) {
    if (m.type === 'ANIME') return [count(m.episodes, 'ep'), m.studios?.nodes?.[0]?.name];
    const author = (m.staff?.edges || []).find((e) => /story|original creator|author/i.test(e.role || ''))
      || m.staff?.edges?.[0];
    return [count(m.volumes, 'vol') || count(m.chapters, 'ch', 'ch'), author?.node?.name?.native || author?.node?.name?.full];
  }

  providers.anilist = {
    name: 'AniList',
    parseUrl(u) {
      if (!hostIs(u, 'anilist.co')) return null;
      const m = /^\/(anime|manga)\/(\d+)/.exec(u.pathname);
      return m ? { kind: m[1], id: +m[2] } : null;
    },
    normalize(m) {
      return makeResult({
        source: 'anilist',
        malId: m.idMal,
        url: m.siteUrl || `https://anilist.co/${(m.type || 'anime').toLowerCase()}/${m.id}`,
        title: m.title?.romaji || m.title?.english || m.title?.native,
        jpTitle: anilistJapaneseTitle(m),
        romaji: m.title?.romaji, english: m.title?.english,
        year: m.startDate?.year, format: ANILIST_FORMAT[m.format] || m.format,
        mediaType: m.type === 'ANIME' ? MEDIA.ANIME : m.format === 'NOVEL' ? MEDIA.NOVEL : MEDIA.MANGA,
        image: m.coverImage?.medium,
        adultCover: m.isAdult,
        details: anilistDetails(m),
      });
    },
    async fetchById({ id }, { signal } = {}) {
      const q = `query($id:Int){Media(id:$id){${ANILIST_FIELDS}}}`;
      const r = await postJson('https://graphql.anilist.co', { query: q, variables: { id } }, { signal });
      return r?.data?.Media ? this.normalize(r.data.Media) : null;
    },
    // AniList entries for MyAnimeList ids, so MAL-only search hits that AniList also has can be shown as AniList.
    async byMalIds(ids, mediaType, { signal } = {}) {
      if (!ids.length) return [];
      const filter = mediaType === MEDIA.ANIME ? 'type:ANIME, format_not_in:[MUSIC]' : 'type:MANGA';
      const q = `query($ids:[Int]){Page(perPage:${ids.length}){media(idMal_in:$ids, ${filter}){${ANILIST_FIELDS}}}}`;
      const r = await postJson('https://graphql.anilist.co', { query: q, variables: { ids } }, { signal });
      return (r?.data?.Page?.media || []).map((m) => this.normalize(m));
    },
    async search(query, mediaType, { signal } = {}) {
      const vars = { s: query };
      let filter = 'type:ANIME, format_not_in:[MUSIC]'; // music videos aren't requestable media
      if (mediaType === MEDIA.MANGA) filter = 'type:MANGA, format_in:[MANGA, ONE_SHOT]';
      else if (mediaType === MEDIA.NOVEL || mediaType === MEDIA.NONFICTION) filter = 'type:MANGA, format_in:[NOVEL]';
      const q = `query($s:String){Page(perPage:8){media(search:$s, ${filter}, sort:SEARCH_MATCH){${ANILIST_FIELDS}}}}`;
      const r = await postJson('https://graphql.anilist.co', { query: q, variables: vars }, { signal });
      return (r?.data?.Page?.media || []).map((m) => this.normalize(m));
    },
  };

  // --- VNDB ------------------------------------------------------------------
  const VNDB_FIELDS = 'id,title,alttitle,olang,released,length_minutes,titles{lang,title,latin,official,main},image{url,sexual},developers{name,original}';

  function vndbJapaneseTitle(vn) {
    const ja = (vn.titles || []).filter((t) => t.lang === 'ja');
    const pick = ja.find((t) => t.official && t.main) || ja.find((t) => t.official) || ja[0];
    if (pick?.title) return pick.title;
    if (vn.olang === 'ja' && hasJapanese(vn.alttitle)) return vn.alttitle;
    if (hasJapanese(vn.alttitle)) return vn.alttitle;
    return null;
  }

  providers.vndb = {
    name: 'VNDB',
    parseUrl(u) {
      if (!hostIs(u, 'vndb.org')) return null;
      const m = /^\/(v\d+)(?:\/|$)/.exec(u.pathname);
      return m ? { id: m[1] } : null;
    },
    normalize(vn) {
      return makeResult({
        source: 'vndb',
        url: `https://vndb.org/${vn.id}`,
        title: vn.title,
        jpTitle: vndbJapaneseTitle(vn),
        romaji: vn.title,
        year: yearOf(vn.released),
        mediaType: MEDIA.VN,
        // VNDB rates covers 0 (safe) to 2 (explicit); explicit ones count as adult
        image: vn.image?.url,
        adultCover: (vn.image?.sexual ?? 0) >= 1.5,
        details: [vn.developers?.[0]?.original || vn.developers?.[0]?.name,
          vn.length_minutes ? `~${Math.round(vn.length_minutes / 60)}h` : null],
      });
    },
    async fetchById({ id }, { signal } = {}) {
      const r = await postJson('https://api.vndb.org/kana/vn', { filters: ['id', '=', id], fields: VNDB_FIELDS }, { signal });
      return r?.results?.[0] ? this.normalize(r.results[0]) : null;
    },
    async search(query, _type, { signal } = {}) {
      const r = await postJson('https://api.vndb.org/kana/vn',
        { filters: ['search', '=', query], fields: VNDB_FIELDS, sort: 'searchrank', results: 8 }, { signal });
      return (r?.results || []).map((v) => this.normalize(v));
    },
  };

  // Music videos, promos and commercials aren't requestable media.
  const isSearchableMalType = (type) => !/^(music|pv|cm)$/i.test(type || '');

  // MyAnimeList's search matches loosely (any word), so a result is kept only when every
  // word of a Latin-script query appears in one of its titles. Japanese queries aren't split.
  function malMatchesQuery(d, query) {
    if (hasJapanese(query)) return true;
    const words = query.toLowerCase().split(/[\s:;,.!?・-]+/).filter((w) => w.length >= 2);
    const names = [d.title, d.title_english, d.title_japanese, ...(d.title_synonyms || []), ...(d.titles || []).map((t) => t.title)]
      .filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => names.includes(w));
  }

  // --- MyAnimeList (through Tenrai) -------------------------------------------
  const MAL_API = 'https://api.tenrai.org/v1';

  providers.mal = {
    name: 'MyAnimeList',
    parseUrl(u) {
      if (!hostIs(u, 'myanimelist.net')) return null;
      const m = /^\/(anime|manga)\/(\d+)/.exec(u.pathname);
      return m ? { kind: m[1], id: +m[2] } : null;
    },
    normalize(d, kind) {
      const titles = d.titles || [];
      const byType = (t) => titles.find((x) => x.type === t)?.title;
      // MAL's "Japanese" title is the original-language one, which is Korean or Chinese for
      // non-Japanese works, so a kana title (often a synonym) wins when there is one.
      const original = d.title_japanese || byType('Japanese');
      const kanaTitle = [original, ...(d.title_synonyms || []), ...titles.map((t) => t.title)].find(hasKana);
      const jp = kanaTitle || original;
      const k = kind || (d.episodes !== undefined || d.aired ? 'anime' : 'manga');
      return makeResult({
        source: 'mal',
        malId: d.mal_id,
        url: d.url || `https://myanimelist.net/${k}/${d.mal_id}`,
        title: d.title || byType('Default'),
        jpTitle: hasJapanese(jp) ? jp : null,
        romaji: d.title, english: d.title_english || byType('English'),
        year: d.year || yearOf(d.aired?.from || d.published?.from),
        format: d.type,
        mediaType: k === 'anime' ? MEDIA.ANIME : /novel/i.test(d.type || '') ? MEDIA.NOVEL : MEDIA.MANGA,
        details: k === 'anime'
          ? [count(d.episodes, 'ep'), d.studios?.[0]?.name]
          // MAL writes people as "Family, Given"; Japanese order is the same without the comma
          : [count(d.volumes, 'vol') || count(d.chapters, 'ch', 'ch'), d.authors?.[0]?.name?.replace(/,\s*/, ' ')],
        image: d.images?.jpg?.small_image_url || d.images?.jpg?.image_url,
        adultCover: /^Rx/i.test(d.rating || '')
          || [...(d.genres || []), ...(d.explicit_genres || [])].some((g) => /hentai|erotica/i.test(g.name || '')),
      });
    },
    async fetchById({ kind, id }, { signal } = {}) {
      const r = await request({ url: `${MAL_API}/${kind}/${id}`, signal });
      return r?.data ? this.normalize(r.data, kind) : null;
    },
    async search(query, mediaType, { signal } = {}) {
      let path = `anime?q=${encodeURIComponent(query)}`;
      let kind = 'anime';
      if (mediaType === MEDIA.MANGA) { path = `manga?q=${encodeURIComponent(query)}&type=manga`; kind = 'manga'; }
      else if (mediaType === MEDIA.NOVEL || mediaType === MEDIA.NONFICTION) {
        path = `manga?q=${encodeURIComponent(query)}&type=lightnovel`; kind = 'manga';
      }
      const r = await request({ url: `${MAL_API}/${path}&limit=8`, signal });
      return (r?.data || []).filter((d) => isSearchableMalType(d.type) && malMatchesQuery(d, query))
        .map((d) => this.normalize(d, kind));
    },
  };

  // --- Syosetu (Shousetsuka ni Narou) ---------------------------------------
  const SYOSETU_FIELDS = 't-n-w-nt-e-gf-ga';
  const SYOSETU_HOSTS = { 'ncode.syosetu.com': 'novelapi', 'novel18.syosetu.com': 'novel18api' };

  providers.syosetu = {
    name: 'Syosetu',
    noCovers: true,
    parseUrl(u) {
      const api = SYOSETU_HOSTS[u.hostname];
      const m = /^\/(n\d{4}[a-z]{1,2})(?:\/|$)/i.exec(u.pathname);
      return api && m ? { api, host: u.hostname, ncode: m[1].toLowerCase() } : null;
    },
    normalize(d, host = 'ncode.syosetu.com') {
      const ncode = String(d.ncode || '').toLowerCase();
      return makeResult({
        source: 'syosetu',
        url: `https://${host}/${ncode}/`,
        title: d.title,
        jpTitle: d.title,
        year: yearOf(d.general_firstup),
        format: d.noveltype === 2 ? 'Short story' : d.end === 1 ? 'Ongoing serial' : 'Finished serial',
        details: [d.writer, d.noveltype === 2 ? null : count(d.general_all_no, 'chapter')],
        mediaType: MEDIA.WEBNOVEL,
      });
    },
    async query(api, params, signal) {
      const r = await request({ url: `https://api.syosetu.com/${api}/api/?out=json&of=${SYOSETU_FIELDS}&${params}`, signal });
      return Array.isArray(r) ? r.slice(1) : []; // first element is { allcount }
    },
    async fetchById({ api, host, ncode }, { signal } = {}) {
      const [d] = await this.query(api, `ncode=${ncode}`, signal);
      return d ? this.normalize(d, host) : null;
    },
    async search(query, _type, { signal } = {}) {
      const rows = await this.query('novelapi', `lim=8&title=1&order=hyoka&word=${encodeURIComponent(query)}`, signal);
      return rows.map((d) => this.normalize(d));
    },
  };

  // ---------------------------------------------------------------------------
  // URL detection
  // ---------------------------------------------------------------------------

  function detectUrl(raw) {
    const u = toUrl(raw);
    if (!u) return null;
    for (const [key, p] of Object.entries(providers)) {
      const ref = p.parseUrl(u);
      if (ref) return { key, provider: p, ref };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Settings dialog
  // ---------------------------------------------------------------------------

  const SETTING_FIELDS = [
    { key: 'searchAsYouType', label: 'Search external sites while typing a title', type: 'checkbox', def: true },
    { key: 'showAdultCovers', label: 'Show adult covers in search results', type: 'checkbox', def: false },
  ];

  function openSettings() {
    document.querySelector('.jre-modal-backdrop')?.remove();
    const back = el('div', { class: 'jre-modal-backdrop' });
    const box = el('div', { class: 'jre-modal' });
    box.append(el('h3', {}, 'Jiten Request Enhancer'));
    const inputs = {};
    for (const f of SETTING_FIELDS) {
      const row = el('label', { class: 'jre-row' + (f.type === 'checkbox' ? ' jre-row-check' : '') });
      const input = el('input', { type: f.type });
      if (f.type === 'checkbox') input.checked = !!settings.get(f.key, f.def);
      else input.value = settings.get(f.key, '') || '';
      inputs[f.key] = input;
      if (f.type === 'checkbox') row.append(input, el('span', {}, f.label));
      else row.append(el('span', {}, f.label), input);
      box.append(row);
    }
    const save = el('button', { class: 'jre-btn' }, 'Save');
    const cancel = el('button', { class: 'jre-btn jre-btn-secondary' }, 'Cancel');
    save.onclick = () => {
      for (const f of SETTING_FIELDS) {
        settings.set(f.key, f.type === 'checkbox' ? inputs[f.key].checked : inputs[f.key].value.trim());
      }
      back.remove();
    };
    cancel.onclick = () => back.remove();
    back.onclick = (e) => { if (e.target === back) back.remove(); };
    box.append(el('div', { class: 'jre-actions' }, cancel, save));
    back.append(box);
    document.body.append(back);
  }

  gmMenu?.('Jiten Request Enhancer settings', openSettings);

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v; else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  }

  function setVueValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Each form field is <div><label class="font-semibold">Label</label><control/></div>.
  function fieldByLabel(root, re) {
    for (const label of root.querySelectorAll('label')) {
      if (re.test(clean(label.textContent))) return label.parentElement;
    }
    return null;
  }

  function findForm() {
    const titleField = fieldByLabel(document, /^Title\s*\*?$/);
    const urlField = fieldByLabel(document, /^External URL/);
    const typeField = fieldByLabel(document, /^Media Type/);
    const title = titleField?.querySelector('input');
    const url = urlField?.querySelector('input');
    if (!title || !url) return null;
    return { titleField, urlField, typeField, title, url };
  }

  // "This is an update to an existing media" mode: the script stays out of the way.
  const isUpdateRequest = () => !!document.getElementById('isUpdate')?.checked;

  function currentMediaType(form) {
    const label = form.typeField?.querySelector('.p-select-label');
    const text = clean(label?.textContent);
    if (!text || label?.classList.contains('p-placeholder') || /^Select media type$/i.test(text)) return null;
    return Object.values(MEDIA).find((m) => m.toLowerCase() === text.toLowerCase()) || null;
  }

  // Finds the Vue component instance whose root element is `el`, by walking the
  // vnode tree from the app's mount container (kept in production builds).
  function vueComponentFor(el) {
    let container = el;
    while (container && !container._vnode) container = container.parentElement;
    if (!container) return null;
    const stack = [container._vnode];
    let budget = 20000;
    while (stack.length && budget-- > 0) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (v.component) {
        if (v.component.subTree?.el === el) return v.component;
        stack.push(v.component.subTree);
      }
      if (v.suspense) stack.push(v.suspense.activeBranch);
      if (Array.isArray(v.children)) stack.push(...v.children);
    }
    return null;
  }

  // Sets the PrimeVue Select through its v-model, as picking an option would.
  async function setSelectByVue(root, label) {
    const comp = vueComponentFor(root);
    const props = comp?.props;
    if (!comp?.emit || !Array.isArray(props?.options)) return false;
    let value = null;
    if (label !== null) {
      const labelOf = (o) => (props.optionLabel && o && typeof o === 'object' ? o[props.optionLabel] : o);
      const option = props.options.find((o) => labelOf(o) === label);
      if (option === undefined) return false;
      value = props.optionValue && typeof option === 'object' ? option[props.optionValue] : option;
    }
    comp.emit('update:modelValue', value);
    comp.emit('change', { originalEvent: null, value });
    await sleep(0);
    return true;
  }

  async function selectMediaType(form, label) {
    const root = form.typeField?.querySelector('.p-select');
    if (!root || root.classList.contains('p-disabled')) return false;
    if (await setSelectByVue(root, label) && currentMediaType(form) === label) return true;
    return selectMediaTypeByClick(form, root, label);
  }

  async function clearMediaType(form) {
    const root = form.typeField?.querySelector('.p-select');
    if (!root || root.classList.contains('p-disabled')) return false;
    return (await setSelectByVue(root, null)) && currentMediaType(form) === null;
  }

  // Fallback: drive the Select like a user, open it and pick the option.
  // The overlay is hidden while this runs and focus goes back where it was.
  async function selectMediaTypeByClick(form, root, label) {
    const html = document.documentElement;
    const previousFocus = document.activeElement;
    const findOption = () => document.querySelector(`.p-select-overlay li[role="option"][aria-label="${label}"]`);
    html.classList.add('jre-picking');
    try {
      if (!findOption()) root.click();
      for (let i = 0; i < 20 && !findOption(); i++) await sleep(25);
      const option = findOption();
      if (!option) {
        if (document.querySelector('.p-select-overlay')) root.click(); // toggles it closed
        return false;
      }
      // PrimeVue 4 selects on mousedown; click covers versions that use click.
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      await sleep(0);
      if (currentMediaType(form) !== label && option.isConnected) { option.click(); await sleep(0); }
      return currentMediaType(form) === label;
    } finally {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      // Keep the overlay hidden until its closing transition has finished.
      for (let i = 0; i < 20 && document.querySelector('.p-select-overlay'); i++) await sleep(25);
      html.classList.remove('jre-picking');
    }
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
  .jre-picking .p-select-overlay{opacity:0!important;pointer-events:none!important;transition:none!important}
  .jre-status{font-size:.8rem;opacity:.8}
  .jre-status:empty{display:none}
  .jre-status.jre-err{color:var(--p-red-500,#e11d48);opacity:1}
  .jre-wrap{position:relative}
  .jre-dd{position:absolute;left:0;right:0;top:100%;margin-top:4px;z-index:1000;max-height:420px;overflow:auto;
    background:var(--p-content-background,var(--p-surface-0,#fff));color:var(--p-text-color,#111);
    border:1px solid var(--p-content-border-color,var(--p-surface-300,#ccc));border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
  .jre-group{padding:6px 10px 2px;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;opacity:.6;display:flex;justify-content:space-between}
  .jre-item{display:flex;gap:10px;align-items:center;padding:6px 10px;cursor:pointer}
  .jre-item:hover,.jre-item.jre-active{background:var(--p-highlight-background,rgba(128,128,128,.18))}
  .jre-item img,.jre-noimg{width:34px;height:48px;object-fit:cover;border-radius:3px;flex:none;background:rgba(128,128,128,.2)}
  .jre-main{min-width:0;flex:1}
  .jre-t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .jre-s{font-size:.8rem;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .jre-msg{padding:6px 10px;font-size:.8rem;opacity:.75}
  .jre-msg.jre-err{color:var(--p-red-500,#e11d48);opacity:1}
  .jre-msg a{text-decoration:underline;cursor:pointer}
  .jre-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px}
  .jre-modal{background:var(--p-content-background,#fff);color:var(--p-text-color,#111);border-radius:10px;padding:18px;width:min(520px,100%);display:flex;flex-direction:column;gap:10px}
  .jre-modal h3{margin:0;font-size:1.1rem;font-weight:700}
  .jre-row{display:flex;flex-direction:column;gap:4px;font-size:.85rem}
  .jre-row input[type=text],.jre-row input[type=password]{padding:6px 8px;border:1px solid var(--p-content-border-color,#ccc);border-radius:6px;background:transparent;color:inherit}
  .jre-row-check{flex-direction:row;align-items:center;gap:8px}
  .jre-actions{display:flex;justify-content:flex-end;gap:8px}
  .jre-btn{padding:6px 14px;border-radius:6px;border:0;background:var(--p-primary-color,#6366f1);color:var(--p-primary-contrast-color,#fff);cursor:pointer}
  .jre-btn-secondary{background:transparent;color:inherit;border:1px solid var(--p-content-border-color,#ccc)}
  `;

  function injectStyles() {
    if (document.getElementById('jre-style')) return;
    const s = el('style', { id: 'jre-style' });
    s.textContent = CSS;
    document.head.append(s);
  }

  // ---------------------------------------------------------------------------
  // Form enhancement
  // ---------------------------------------------------------------------------

  const cache = new Map();

  async function cached(key, fn) {
    if (cache.has(key)) return cache.get(key);
    const p = fn();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function enhance(form) {
    if (form.title.dataset.jre) return;
    form.title.dataset.jre = '1';
    injectStyles();

    let lastFilledUrl = null;  // URL the script itself put in the field
    let autoType = null;       // media type the script itself selected

    // --- URL → title -------------------------------------------------------
    const urlStatus = el('div', { class: 'jre-status' });
    form.url.insertAdjacentElement('afterend', urlStatus);
    let urlAbort = null;

    const setStatus = (node, text, err = false) => {
      node.textContent = text || '';
      node.classList.toggle('jre-err', !!err);
    };

    const onUrl = debounce(async () => {
      if (isUpdateRequest()) { setStatus(urlStatus, ''); return; }
      const raw = form.url.value.trim();
      urlAbort?.abort();
      const hit = detectUrl(raw);
      if (!raw) {
        // Link cleared: drop the title too, unless the user edited it after the script filled it.
        if (form.title.dataset.jreFilled && form.title.value === form.title.dataset.jreFilled) {
          setVueValue(form.title, '');
        }
        setStatus(urlStatus, '');
        delete form.title.dataset.jreFilled;
        delete form.url.dataset.jreFilled;
        lastFilledUrl = null;
        if (autoType && currentMediaType(form) === autoType) await clearMediaType(form);
        autoType = null;
        return;
      }
      if (!hit) { setStatus(urlStatus, ''); return; }
      if (raw === lastFilledUrl) return;
      // Another script filled this link together with its title: no lookup until the link changes.
      if (form.url.dataset.jreFilled === raw) { lastFilledUrl = raw; return; }
      const ctrl = new AbortController();
      urlAbort = ctrl;
      setStatus(urlStatus, '');
      try {
        const res = await cached(`id:${hit.key}:${JSON.stringify(hit.ref)}`, () => hit.provider.fetchById(hit.ref, { signal: ctrl.signal }));
        if (ctrl.signal.aborted) return;
        if (!res?.fillTitle) { setStatus(urlStatus, `${hit.provider.name} has no entry for this link.`, true); return; }
        form.title.dataset.jreFilled = res.fillTitle;
        setVueValue(form.title, res.fillTitle);
        await autoSelectType(res);
      } catch (e) {
        if (e.name !== 'AbortError') setStatus(urlStatus, e.message, true);
      }
    }, 400);

    // Fills an empty media type, or replaces one the script set earlier;
    // never overrides the user's own choice.
    const autoSelectType = async (res) => {
      const current = currentMediaType(form);
      if (!res.mediaType || current === res.mediaType || (current && current !== autoType)) return;
      if (await selectMediaType(form, res.mediaType)) autoType = res.mediaType;
    };

    form.url.addEventListener('input', onUrl);
    form.url.addEventListener('paste', () => setTimeout(onUrl, 0));

    // --- Title → search ----------------------------------------------------
    const wrap = form.title.parentElement;
    wrap.classList.add('jre-wrap');
    let dd = null;
    let items = [];
    let active = -1;
    let searchAbort = null;
    let lastQueryKey = '';

    const close = () => { dd?.remove(); dd = null; items = []; active = -1; };

    const highlight = (i) => {
      items.forEach((n, j) => n.classList.toggle('jre-active', j === i));
      active = i;
      items[i]?.scrollIntoView({ block: 'nearest' });
    };

    const choose = (res) => {
      form.title.dataset.jreFilled = res.fillTitle;
      setVueValue(form.title, res.fillTitle);
      lastFilledUrl = res.url;
      setVueValue(form.url, res.url);
      setStatus(urlStatus, '');
      close();
      lastQueryKey = '';
    };

    const renderItem = (res) => {
      const names = [res.jpTitle && res.title !== res.jpTitle ? res.title : null,
        res.english && res.english !== res.title ? res.english : null].filter(Boolean).join(' · ');
      const facts = [res.format, ...res.details, res.year].filter(Boolean).join(' · ');
      const node = el('div', { class: 'jre-item', title: res.url },
        res.image && (!res.adultCover || settings.get('showAdultCovers', false))
          ? el('img', { src: res.image, loading: 'lazy', referrerpolicy: 'no-referrer' })
          : providers[res.source]?.noCovers ? null : el('div', { class: 'jre-noimg' }),
        el('div', { class: 'jre-main' }, el('div', { class: 'jre-t' }, res.fillTitle),
          names ? el('div', { class: 'jre-s' }, names) : null, el('div', { class: 'jre-s' }, facts)));
      node.addEventListener('mousedown', (e) => { e.preventDefault(); choose(res); });
      return node;
    };

    const ensureDropdown = () => {
      if (!dd) { dd = el('div', { class: 'jre-dd' }); wrap.append(dd); }
      return dd;
    };

    const runSearch = debounce(async () => {
      // A title the script itself wrote (from a link or a picked result) isn't searched.
      if (form.title.dataset.jreFilled && form.title.value === form.title.dataset.jreFilled) { close(); return; }
      if (!settings.get('searchAsYouType', true) || isUpdateRequest()) { close(); return; }
      const q = form.title.value.trim();
      const type = currentMediaType(form);
      const order = PRIORITY[type] || [];
      if (q.length < 2 || !order.length) { close(); return; }
      const key = `${type}|${q}`;
      if (key === lastQueryKey && dd) return;
      lastQueryKey = key;
      searchAbort?.abort();
      const ctrl = new AbortController();
      searchAbort = ctrl;

      const box = ensureDropdown();
      box.replaceChildren();
      items = []; active = -1;
      const sections = order.map((k) => {
        const head = el('div', { class: 'jre-group' }, el('span', {}, providers[k].name), el('span', {}, 'searching…'));
        const body = el('div');
        box.append(head, body);
        let markReady;
        const ready = new Promise((r) => { markReady = r; });
        return { k, head, body, ready, markReady };
      });

      const searches = Object.fromEntries(order.map((k) => [k,
        cached(`s:${k}:${type}:${q.toLowerCase()}`, () => providers[k].search(q, type, { signal: ctrl.signal }))]));

      const sectionOf = Object.fromEntries(sections.map((sec) => [sec.k, sec]));

      // MAL hits AniList also has: drop the ones AniList's own search returned, and move the rest
      // into the AniList section (looked up by MAL id), so only MAL-only entries stay under MAL.
      const coverWith = async (k, results) => {
        const by = COVERED_BY[k];
        const covering = by && searches[by] ? await searches[by].catch(() => null) : null;
        if (!covering) return results;
        let rest = withoutCovered(results, covering);
        const ids = rest.map((r) => r.malId).filter(Boolean);
        const moved = await cached(`mal-ids:${type}:${ids.join(',')}`,
          () => providers[by].byMalIds(ids, type, { signal: ctrl.signal })).catch(() => []);
        const target = sectionOf[by];
        await target?.ready;
        if (moved.length && target && !ctrl.signal.aborted) {
          target.head.lastChild.textContent = '';
          for (const r of moved) target.body.append(renderItem(r));
        }
        rest = withoutCovered(rest, moved);
        return rest;
      };

      await Promise.all(sections.map(async ({ k, head, body, markReady }) => {
        try {
          let results = await searches[k];
          const found = results.length;
          results = await coverWith(k, results);
          if (ctrl.signal.aborted) return;
          head.lastChild.textContent = results.length ? '' : found ? 'no other results' : 'no results';
          for (const r of results) body.append(renderItem(r));
        } catch (e) {
          if (e.name === 'AbortError' || ctrl.signal.aborted) return;
          head.lastChild.textContent = '';
          body.append(el('div', { class: 'jre-msg' }, e.message));
        } finally {
          markReady();
        }
      }));
      if (!ctrl.signal.aborted && dd) items = [...dd.querySelectorAll('.jre-item')];
    }, 500);

    // A link typed or pasted into Title belongs in External URL.
    form.title.addEventListener('input', () => {
      const v = form.title.value.trim();
      if (isUpdateRequest() || !/^https?:\/\/\S+$/i.test(v)) return;
      setVueValue(form.title, '');
      setVueValue(form.url, v); // triggers the URL lookup
    });
    form.title.addEventListener('input', runSearch);
    form.title.addEventListener('focus', () => { lastQueryKey = ''; if (form.title.value.trim().length >= 2) runSearch(); });
    form.title.addEventListener('blur', () => setTimeout(close, 150));
    form.title.addEventListener('keydown', (e) => {
      if (!dd) return;
      items = [...dd.querySelectorAll('.jre-item')];
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(items.length - 1, active + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); items[active].dispatchEvent(new MouseEvent('mousedown')); }
      else if (e.key === 'Escape') close();
    });

    // Re-run search when the media type changes.
    if (form.typeField) {
      let lastType = currentMediaType(form);
      new MutationObserver(() => {
        const t = currentMediaType(form);
        if (t !== lastType) {
          lastType = t;
          lastQueryKey = '';
          if (document.activeElement === form.title) runSearch();
        }
      }).observe(form.typeField, { subtree: true, childList: true, characterData: true });
    }
  }

  // ---------------------------------------------------------------------------
  // SPA routing: attach whenever the request form is on the page.
  // ---------------------------------------------------------------------------

  function tick() {
    if (!/^\/requests\/new\/?$/.test(location.pathname)) return;
    const form = findForm();
    if (form) enhance(form);
  }

  settingsReady.then(() => {
    new MutationObserver(debounce(tick, 150)).observe(document.body, { childList: true, subtree: true });
    tick();
  });
})();
