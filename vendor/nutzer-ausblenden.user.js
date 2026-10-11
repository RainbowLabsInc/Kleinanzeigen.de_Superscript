// ==UserScript==
// @name          Kleinanzeigen - Nutzer ausblenden (Blockliste)
// @namespace     https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden
// @description   Blendet auf Kleinanzeigen.de Anzeigen von Nutzerinnen und Nutzern aus, die du blockierst. Eigene Blockliste mit Notizen, einzelne Anzeigen ausblenden, Listen exportieren, zusammenführen und abonnieren.
// @author        RainbowlabsInc
// @copyright     2026, RainbowlabsInc
// @license       MIT
// @version       0.3.5
// @icon          https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden/raw/main/assets/icon48.png
// @homepage      https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden
// @updateURL     https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden/raw/main/script.user.js
// @downloadURL   https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden/raw/main/script.user.js
// @match         https://www.kleinanzeigen.de/
// @match         https://www.kleinanzeigen.de/?*
// @match         https://www.kleinanzeigen.de/s-*
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_addValueChangeListener
// @grant         GM_registerMenuCommand
// @grant         GM_xmlhttpRequest
// @connect       raw.githubusercontent.com
// @connect       gist.githubusercontent.com
// @connect       *
// @noframes
// @run-at        document-idle
// ==/UserScript==

/*
 * Funktionsweise
 * --------------
 * Anbieter werden über ihre ID gespeichert:
 *   - private Anbieter: die Zahl aus dem Link zur Bestandsliste
 *     (/s-bestandsliste.html?userId=<ID>),
 *   - gewerbliche Anbieter: "pro:<shop>" aus dem Link zur Shop-Seite (/pro/<shop>,
 *     auf der Anzeigenseite im Kasten #viewad-bizteaser).
 *
 * Die Karten in den Suchergebnissen enthalten den Anbieter in der Regel nicht. Darum
 * merkt sich das Script, welche Anzeige zu welchem Anbieter gehört (Anzeigen-Index):
 *   - beim Blockieren: Bestandsliste bzw. Shop-Seite des Anbieters einmal laden,
 *   - danach höchstens einmal am Tag erneut (für neue Anzeigen, abschaltbar),
 *   - beim Öffnen einer Anzeige oder einer Bestandsliste (ohne zusätzliche Anfrage),
 *   - optional: unbekannte Anzeigen der Übersicht im Hintergrund prüfen (aus, weil
 *     dafür pro Anzeige eine Anfrage an Kleinanzeigen nötig ist).
 *
 * 1. Übersicht (Suchergebnisse, /s-..., und die Startseite):
 *    Anzeigen blockierter Anbieter und einzeln ausgeblendete Anzeigen werden
 *    eingeklappt (Hinweiszeile) oder ganz ausgeblendet. Neben dem Preis sitzt ein
 *    "Ausblenden"-Button mit einem kleinen Menü, unten links der Button "Blockliste".
 * 2. Anzeigenseite (/s-anzeige/...): Button "Blockieren" am Anbieter-Namen und fest
 *    unten links, Hinweisleiste bei blockierten Anbietern.
 * 3. Bestandsliste (/s-bestandsliste.html): Leiste zum Blockieren/Freigeben.
 *
 * Kleinanzeigen baut Teile der Seite nach dem Laden neu auf. Das Script beobachtet
 * die Seite und setzt fehlende Buttons, Hinweise und Styles wieder ein.
 *
 * Die Blockliste lässt sich als JSON oder als Textliste (ähnlich einer Filterliste)
 * exportieren. Fremde Listen werden nach einer Vorschau mit der eigenen zusammengeführt;
 * übernommene Einträge merken sich ihre Herkunft und lassen sich gemeinsam wieder
 * freigeben. Listen unter einer festen Adresse lassen sich abonnieren: Sie werden
 * täglich neu geladen und mit der Blockliste abgeglichen. Das Format ist im README
 * beschrieben.
 *
 * Alle Selektoren und Grenzwerte stehen gesammelt in CONFIG.
 */

(function () {
    'use strict';

    const VERSION = '0.3.5';

    const CONFIG = {
        keys: {
            users: 'kua-users',          // { <userId>: { name, note, added, source?, sub? } }
            ads: 'kua-hidden-ads',       // { <adId>: <Zeitstempel> } einzeln ausgeblendete Anzeigen
            index: 'kua-ad-index',       // { <adId>: <userId> } bekannte Zuordnung Anzeige -> Anbieter
            scanned: 'kua-scanned',      // { <userId>: <Zeitstempel> } letzte geladene Bestandsliste
            settings: 'kua-settings',
            subs: 'kua-subs',            // { <url>: { title, added, lastCheck, lastSuccess, error, excluded: [] } }
        },
        defaultSettings: {
            mode: 'collapse',            // 'collapse' = Hinweiszeile, 'hide' = ganz ausblenden
            dailyRefresh: true,          // Bestandslisten blockierter Anbieter täglich neu laden
            autoResolve: false,          // unbekannte Anzeigen der Übersicht im Hintergrund prüfen
        },
        // Größe des Anzeigen-Index; ältere (= kleinere) Anzeigen-Nummern fallen zuerst heraus
        indexMax: 20000,
        // Bestandsliste neu laden, wenn älter als
        refreshAfterMs: 24 * 60 * 60 * 1000,
        // ... aber pro Seitenaufruf höchstens so viele Anbieter
        refreshPerVisit: 3,
        // Seiten pro Bestandsliste bzw. Shop-Seite
        scanMaxPages: 10,
        // Pause zwischen zwei Hintergrund-Anfragen
        requestGapMs: 1200,
        // Höchstens so viele Anzeigen pro Seitenaufruf im Hintergrund prüfen
        autoResolveMax: 30,
        nameMax: 80,
        noteMax: 300,
        sourceMax: 80,
        // Abonnierte Listen: so oft neu laden, pro Seitenaufruf höchstens so viele, max. Größe
        subRefreshMs: 24 * 60 * 60 * 1000,
        subsPerVisit: 2,
        subMaxBytes: 2 * 1024 * 1024,
        subTimeoutMs: 20000,
        // Link zur Bestandsliste bzw. zum Shop (Stand 10/2026)
        sellerUrl: (id) => id.startsWith('pro:')
            ? `/pro/${encodeURIComponent(id.slice(4))}`
            : `/s-bestandsliste.html?userId=${encodeURIComponent(id)}`,
        // Bereiche der Anzeigenseite, in denen der Anbieter steht (in dieser Reihenfolge;
        // gewerbliche Anbieter: #viewad-bizteaser, Stand 10/2026)
        sellerContainers: ['#viewad-contact', '#viewad-profile-box', '#viewad-bizteaser', '.userprofile-vip', '#viewad-sidebar', 'aside'],
        // Linktexte, die kein Anbietername sind
        notAName: /anzeigen|profil|bestandsliste|shop|mehr|folgen/i,
        // Ergebnisliste auf Such- und Bestandslisten-Seiten (Rückfall: größte Liste mit Anzeigen)
        resultListSelectors: ['#srchrslt-adtable'],
        // "Nächste Seite" in der Bestandsliste: Text, title/aria-label bzw. Klasse des Links
        nextPageText: /^(›|»|>|weiter|nächste)/i,
        nextPageLabel: /nächste|weiter|next/i,
        nextPageClass: /(^|[-_\s])next([-_\s]|$)/i,
        listFormat: 'kleinanzeigen-blockliste',
        listFormatVersion: 1,
    };

    // Nur auf kleinanzeigen.de laufen – zusätzlich zu @match, falls der Script-Manager
    // die Header ignoriert oder das Script manuell mit breiteren Regeln eingebunden wird.
    if (window.location.protocol !== 'https:' || window.location.hostname !== 'www.kleinanzeigen.de') return;
    if (window.top !== window.self) return;

    // Doppelt installiert? Dann arbeitet nur die zuerst gestartete Kopie.
    const docRoot = document.documentElement;
    if (docRoot.hasAttribute('data-kua')) {
        console.warn('[Nutzer ausblenden] Script läuft bereits, diese Kopie bleibt inaktiv.');
        return;
    }
    docRoot.setAttribute('data-kua', VERSION);

    const path = window.location.pathname;
    const isDetailPage = path.startsWith('/s-anzeige/');
    const isSellerPage = path === '/s-bestandsliste.html';
    const pageSellerId = isSellerPage ? normalizeUserId(window.location.href) : null;

    // ------------------------------------------------------------------
    // Helfer
    // ------------------------------------------------------------------

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('de-DE') : '');

    function getAdIdFromUrl(url) {
        // /s-anzeige/<slug>/<adId>-<kategorie>-<ort>
        const m = String(url || '').match(/\/s-anzeige\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    const ID_RE = /^(?:\d{1,15}|pro:[a-z0-9][a-z0-9_-]{0,79})$/i;

    // Nutzer-ID aus einem Link zur Bestandsliste / zum Shop
    function userIdFromHref(href) {
        const s = String(href || '');
        let m = s.match(/s-bestandsliste\.html\?(?:[^#]*&)?userId=(\d{1,15})(?!\d)/);
        if (m) return m[1];
        m = s.match(/^(?:https:\/\/www\.kleinanzeigen\.de)?\/pro\/([a-z0-9][a-z0-9_-]{0,79})(?:[/?#]|$)/i);
        // Kleinanzeigen unterscheidet bei /pro/<Shop> nicht nach Groß-/Kleinschreibung
        // (geprüft 10/2026), daher einheitlich klein speichern
        if (m) return 'pro:' + m[1].toLowerCase();
        return null;
    }

    // Nutzer-ID aus Eingabe oder Liste: "12345678", "pro:shop-name" oder ein Link
    function normalizeUserId(raw) {
        if (raw == null) return null;
        const s = String(raw).trim();
        const fromLink = userIdFromHref(s);
        if (fromLink) return fromLink;
        const m = s.match(/[?&]userId=(\d{1,15})(?!\d)/);
        if (m) return m[1];
        return ID_RE.test(s) ? s.toLowerCase() : null;
    }

    // Adresse einer abonnierten Liste: nur https, GitHub-Dateiansicht -> Rohtext
    function normalizeListUrl(raw) {
        if (typeof raw !== 'string') return null;
        let url;
        try { url = new URL(raw.trim()); } catch (e) { return null; }
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        const blob = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
        if (blob) url = new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
        url.hash = '';
        const s = url.href;
        return s.length <= 500 ? s : null;
    }

    const isShop = (id) => id.startsWith('pro:');
    // Eintrag aus einem (noch) abonnierten Abo. Verweist er auf ein Abo, das es nicht mehr gibt,
    // gilt er als eigener Eintrag, damit er sichtbar bleibt und freigegeben werden kann.
    const isSubEntry = (u) => !!(u && u.sub && state.subs[u.sub]);
    const sellerPageName = (id) => (isShop(id) ? 'Shop-Seite' : 'Bestandsliste');

    // Hinweisfeld (<p class="kua-note">) setzen; ohne Text wird es ausgeblendet
    function setNote(node, msg, kind) {
        node.hidden = !msg;
        node.textContent = msg || '';
        if (kind) node.dataset.kind = kind; else delete node.dataset.kind;
    }

    function userLabel(id, fallbackName) {
        const u = state.users[id];
        const name = (u && u.name) || fallbackName;
        if (name) return name;
        return isShop(id) ? `Shop ${id.slice(4)}` : `Nutzer ${id}`;
    }

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else if (k in node && k !== 'list') node[k] = v;
            else node.setAttribute(k, v === true ? '' : v);
        }
        children.flat().forEach(c => c != null && c !== false && node.append(c));
        return node;
    }

    // Buttons liegen teils in komplett verlinkten Karten: Klick darf nicht zur Anzeige navigieren
    // (Bubble-Phase: Listener am selben Element, die vorher registriert wurden, laufen trotzdem.)
    function guard(node) {
        ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(t => node.addEventListener(t, e => e.stopPropagation()));
        node.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
        return node;
    }

    function guardedButton(props, ...children) {
        return guard(el('button', { type: 'button', ...props }, ...children));
    }

    // ------------------------------------------------------------------
    // Speicher: Tampermonkey/Violentmonkey-Speicher, sonst localStorage
    // ------------------------------------------------------------------

    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function load(key, def) {
        try {
            if (hasGM) {
                const v = GM_getValue(key);
                return v === undefined ? def : v;
            }
            const raw = localStorage.getItem(key);
            return raw == null ? def : JSON.parse(raw);
        } catch (e) {
            return def;
        }
    }

    function save(key, value) {
        try {
            if (hasGM) GM_setValue(key, value);
            else localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    // source: Name der Liste, aus der ein Eintrag übernommen wurde (fehlt bei eigenen Einträgen)
    function cleanUser(u) {
        const o = isObj(u) ? u : {};
        const added = typeof o.added === 'number' ? o.added : Date.parse(o.added);
        const user = {
            name: clip(o.name, CONFIG.nameMax),
            note: clip(o.note, CONFIG.noteMax),
            added: Number.isFinite(added) ? added : Date.now(),
        };
        const source = clip(o.source, CONFIG.sourceMax);
        if (source) user.source = source;
        const sub = normalizeListUrl(o.sub);
        if (sub) user.sub = sub;
        return user;
    }

    function loadUsers() {
        const users = {};
        const raw = load(CONFIG.keys.users, {});
        if (isObj(raw)) {
            for (const [id, u] of Object.entries(raw)) {
                const nid = normalizeUserId(id);
                if (nid) users[nid] = cleanUser(u);
            }
        }
        return users;
    }

    function loadMap(key, valueOk) {
        const out = {};
        const raw = load(key, {});
        if (isObj(raw)) {
            for (const [k, v] of Object.entries(raw)) if (valueOk(k, v)) out[k] = v;
        }
        return out;
    }

    function loadIndex() {
        const index = loadMap(CONFIG.keys.index, (k, v) => /^\d{1,15}$/.test(k) && typeof v === 'string' && ID_RE.test(v));
        Object.keys(index).forEach(k => { index[k] = index[k].toLowerCase(); });
        return index;
    }

    function loadState() {
        const settings = { ...CONFIG.defaultSettings };
        const rawSettings = load(CONFIG.keys.settings, {});
        if (isObj(rawSettings)) {
            if (rawSettings.mode === 'hide' || rawSettings.mode === 'collapse') settings.mode = rawSettings.mode;
            if (typeof rawSettings.dailyRefresh === 'boolean') settings.dailyRefresh = rawSettings.dailyRefresh;
            if (typeof rawSettings.autoResolve === 'boolean') settings.autoResolve = rawSettings.autoResolve;
        }
        // IDs vereinheitlichen (0.1.3 hat Shop-IDs in Originalschreibweise gespeichert)
        const index = loadIndex();
        const scanned = {};
        Object.entries(loadMap(CONFIG.keys.scanned, (k, v) => ID_RE.test(k) && typeof v === 'number'))
            .forEach(([k, v]) => { scanned[k.toLowerCase()] = v; });
        return {
            users: loadUsers(),
            ads: loadMap(CONFIG.keys.ads, (k, v) => /^\d{1,15}$/.test(k) && typeof v === 'number'),
            index,
            scanned,
            settings,
            subs: loadSubs(),
        };
    }

    function loadSubs() {
        const subs = {};
        const raw = load(CONFIG.keys.subs, {});
        if (!isObj(raw)) return subs;
        for (const [rawUrl, v] of Object.entries(raw)) {
            const url = normalizeListUrl(rawUrl);
            if (!url || !isObj(v)) continue;
            const num = (x) => (typeof x === 'number' ? x : 0);
            subs[url] = {
                title: clip(v.title, CONFIG.sourceMax),
                added: num(v.added) || Date.now(),
                lastCheck: num(v.lastCheck),
                lastSuccess: num(v.lastSuccess),
                error: clip(v.error, 200),
                excluded: Array.isArray(v.excluded) ? v.excluded.map(normalizeUserId).filter(Boolean) : [],
            };
        }
        return subs;
    }

    let state = loadState();

    const saveUsers = () => save(CONFIG.keys.users, state.users);
    const saveAds = () => save(CONFIG.keys.ads, state.ads);
    const saveScanned = () => save(CONFIG.keys.scanned, state.scanned);
    const saveSettings = () => save(CONFIG.keys.settings, state.settings);
    const saveSubs = () => save(CONFIG.keys.subs, state.subs);

    // Neue Zuordnungen sammeln und gebündelt speichern. Vor dem Speichern mit dem
    // gespeicherten Stand zusammenführen, damit parallel offene Tabs nichts überschreiben.
    let pendingIndex = {};

    function learn(adId, userId) {
        if (!adId || !userId || !ID_RE.test(userId)) return false;
        if (state.index[adId] === userId) return false;
        state.index[adId] = userId;
        pendingIndex[adId] = userId;
        return true;
    }

    function flushIndex() {
        if (!Object.keys(pendingIndex).length) return;
        const merged = { ...loadIndex(), ...pendingIndex };
        const keys = Object.keys(merged);
        if (keys.length > CONFIG.indexMax) {
            keys.sort((a, b) => Number(a) - Number(b))
                .slice(0, keys.length - CONFIG.indexMax)
                .forEach(k => { delete merged[k]; });
        }
        pendingIndex = {};
        state.index = merged;
        save(CONFIG.keys.index, merged);
    }

    // ------------------------------------------------------------------
    // Anbieter erkennen
    // ------------------------------------------------------------------

    // Anbieter einer Anzeigenseite (live oder per fetch geladen): { id, name, el }
    function findSeller(doc) {
        const collect = (root) => {
            const found = new Map();
            root.querySelectorAll('a[href]').forEach(a => {
                if (a.closest('.kua-ui')) return;
                const id = userIdFromHref(a.getAttribute('href'));
                if (!id) return;
                const entry = found.get(id) || { id, name: '', el: a, count: 0 };
                entry.count++;
                const text = clip(a.textContent, CONFIG.nameMax);
                // Profilbild mit Initiale ("K") ist kein Name: dort nicht den Button einsetzen
                if (!entry.name && text.length > 1 && !CONFIG.notAName.test(text)) {
                    entry.name = text;
                    entry.el = a;
                }
                found.set(id, entry);
            });
            return Array.from(found.values()).sort((a, b) => b.count - a.count);
        };
        for (const sel of CONFIG.sellerContainers) {
            const box = doc.querySelector(sel);
            if (!box) continue;
            const hits = collect(box);
            if (hits.length) return hits[0];
        }
        // Rückfall: im ganzen Dokument genau ein Anbieter-Link (Bestandsliste vor Shop)
        const all = collect(doc);
        const regular = all.filter(e => !isShop(e.id));
        if (regular.length === 1) return regular[0];
        if (!regular.length && all.length === 1) return all[0];
        return null;
    }

    // Anzeigen-Nummern der Ergebnisliste (Such- oder Bestandslisten-Seite). Bewusst nur die
    // größte Liste – Empfehlungen anderer Anbieter am Rand sollen nicht im Index landen.
    function mainListAdIds(doc) {
        let scope = null;
        for (const sel of CONFIG.resultListSelectors) {
            scope = doc.querySelector(sel);
            if (scope) break;
        }
        const groups = new Map();
        (scope || doc).querySelectorAll('article[data-adid], a[href*="/s-anzeige/"]').forEach(node => {
            const adId = node.getAttribute('data-adid') || getAdIdFromUrl(node.getAttribute('href'));
            if (!adId || !/^\d{1,15}$/.test(adId)) return;
            const list = scope || node.closest('ul, ol') || doc;
            if (!groups.has(list)) groups.set(list, new Set());
            groups.get(list).add(adId);
        });
        let best = new Set();
        groups.forEach(set => { if (set.size > best.size) best = set; });
        return Array.from(best);
    }

    async function fetchDoc(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
    }

    // Anbieter einer Anzeige über ihre Seite ermitteln (eine Anfrage, wie beim Öffnen)
    async function resolveSeller(info) {
        const doc = await fetchDoc(info.href.split('#')[0]);
        const seller = findSeller(doc);
        if (seller) {
            learn(info.adId, seller.id);
            flushIndex();
        }
        return seller;
    }

    // Seitenzahl aus einer Adresse: ?pageNum=2 / ?page=2 / ?seite=2 oder .../seite:2/...
    function pageNumber(url) {
        for (const [k, v] of url.searchParams) {
            if (/^(pagenum|page|seite)$/i.test(k) && /^\d+$/.test(v)) return Number(v);
        }
        const m = url.pathname.match(/\/seite:(\d+)(?:\/|$)/);
        return m ? Number(m[1]) : 1;
    }

    // Adresse der nächsten Seite einer Bestandsliste/Shop-Seite, oder null.
    // 1. ausgezeichneter "Weiter"-Link (rel="next", Text, title/aria-label, Klasse "…next…"),
    // 2. sonst der Link mit der nächsthöheren Seitenzahl.
    function nextPageUrl(doc, userId, visited, currentUrl) {
        const toSellerUrl = (href) => {
            if (!href) return null;
            let url;
            try { url = new URL(href, window.location.origin); } catch (e) { return null; }
            if (url.origin !== window.location.origin || normalizeUserId(url.href) !== userId) return null;
            return url;
        };
        const fresh = (url) => url && !visited.has(url.pathname + url.search);

        const marked = [
            ...doc.querySelectorAll('link[rel="next"], a[rel="next"]'),
            ...Array.from(doc.querySelectorAll('a[href]')).filter(a =>
                CONFIG.nextPageText.test(clip(a.textContent, 20))
                || CONFIG.nextPageLabel.test(a.getAttribute('aria-label') || '')
                || CONFIG.nextPageLabel.test(a.getAttribute('title') || '')
                || CONFIG.nextPageClass.test(a.getAttribute('class') || '')),
        ];
        for (const a of marked) {
            const url = toSellerUrl(a.getAttribute('href'));
            if (fresh(url)) return url.pathname + url.search;
        }

        const current = pageNumber(new URL(currentUrl, window.location.origin));
        for (const a of doc.querySelectorAll('a[href]')) {
            const url = toSellerUrl(a.getAttribute('href'));
            if (fresh(url) && pageNumber(url) === current + 1) return url.pathname + url.search;
        }
        return null;
    }

    // Bestandsliste bzw. Shop-Seite eines Anbieters laden und seine Anzeigen im Index vermerken
    const scanning = new Set();

    async function scanSeller(userId) {
        if (scanning.has(userId)) return 0;
        scanning.add(userId);
        try {
            const visited = new Set();
            let url = CONFIG.sellerUrl(userId);
            let count = 0;
            for (let page = 0; url && page < CONFIG.scanMaxPages; page++) {
                if (page) await sleep(CONFIG.requestGapMs);
                visited.add(url);
                const doc = await fetchDoc(url);
                const ids = mainListAdIds(doc);
                ids.forEach(adId => learn(adId, userId));
                count += ids.length;
                url = ids.length ? nextPageUrl(doc, userId, visited, url) : null;
            }
            state.scanned[userId] = Date.now();
            saveScanned();
            flushIndex();
            return count;
        } finally {
            scanning.delete(userId);
        }
    }

    async function refreshBlockedSellers() {
        if (!state.settings.dailyRefresh) return;
        const now = Date.now();
        const due = Object.keys(state.users)
            .filter(id => now - (state.scanned[id] || 0) > CONFIG.refreshAfterMs)
            .sort((a, b) => (state.scanned[a] || 0) - (state.scanned[b] || 0))
            .slice(0, CONFIG.refreshPerVisit);
        for (const id of due) {
            // Inzwischen schon eingelesen (z. B. direkt nach dem Blockieren) oder freigegeben?
            if (!state.users[id] || Date.now() - (state.scanned[id] || 0) <= CONFIG.refreshAfterMs) continue;
            try {
                await scanSeller(id);
                refreshPage();
            } catch (e) {
                console.warn(`[Nutzer ausblenden] ${sellerPageName(id)} nicht geladen:`, id, e);
            }
            await sleep(CONFIG.requestGapMs);
        }
    }

    // ------------------------------------------------------------------
    // Blockieren / Freigeben
    // ------------------------------------------------------------------

    let refreshPage = () => {};

    function blockUser(id, name, note) {
        state.users[id] = cleanUser({ name, note, added: Date.now() });
        saveUsers();
        refreshPage();
        const label = userLabel(id);
        const undo = { label: 'Rückgängig', onClick: () => { unblockUser(id); hideToast(); } };
        showToast(`„${label}“ blockiert.`, 'ok', [undo], 8000);
        scanSeller(id).then(n => {
            refreshPage();
            // Verwaltung offen (Anbieter dort hinzugefügt)? Zahl der bekannten Anzeigen nachziehen
            if (panel) renderPanel();
            if (state.users[id]) {
                showToast(`„${label}“ blockiert, ${n} Anzeige${n === 1 ? '' : 'n'} auf der ${sellerPageName(id)} gefunden.`, 'ok', [undo], 6000);
            }
        }).catch(e => {
            console.warn(`[Nutzer ausblenden] ${sellerPageName(id)} nicht geladen:`, id, e);
        });
    }

    function unblockUser(id) {
        const u = state.users[id];
        if (!u) return;
        // Aus einem Abo: als Ausnahme merken, sonst käme der Eintrag beim nächsten Abgleich zurück
        const sub = u.sub && state.subs[u.sub];
        if (sub && !sub.excluded.includes(id)) {
            sub.excluded.push(id);
            saveSubs();
        }
        delete state.users[id];
        saveUsers();
        refreshPage();
    }

    function hideAd(adId) {
        state.ads[adId] = Date.now();
        saveAds();
        refreshPage();
    }

    function unhideAd(adId) {
        delete state.ads[adId];
        saveAds();
        refreshPage();
    }

    // ------------------------------------------------------------------
    // Abonnierte Listen
    // ------------------------------------------------------------------

    // Lädt die Liste ohne Cookies. GM_xmlhttpRequest umgeht die Sicherheitsregeln der Seite
    // (Tampermonkey fragt beim ersten Abruf einer neuen Adresse ggf. nach); ohne fetch().
    function fetchListText(url) {
        return new Promise((resolve, reject) => {
            const check = (text) => (text.length > CONFIG.subMaxBytes
                ? reject(new Error('Die Liste ist zu groß (max. 2 MB).')) : resolve(text));
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET', url, anonymous: true, timeout: CONFIG.subTimeoutMs,
                    headers: { 'Cache-Control': 'no-cache' },
                    onload: (r) => (r.status >= 200 && r.status < 300 ? check(r.responseText || '') : reject(new Error(`HTTP ${r.status}`))),
                    onerror: () => reject(new Error('Adresse nicht erreichbar oder Zugriff nicht erlaubt')),
                    ontimeout: () => reject(new Error('Zeitüberschreitung')),
                });
            } else {
                fetch(url, { credentials: 'omit', cache: 'no-cache' })
                    .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
                    .then(check, () => reject(new Error('Adresse nicht erreichbar')));
            }
        });
    }

    // Gleicht ein Abo mit der Blockliste ab: neue Anbieter dazu, nicht mehr gelistete weg.
    // Eigene Einträge und Einträge aus anderen Listen bleiben unberührt, Ausnahmen werden übersprungen.
    // Einzelne Anzeigen (anzeige:...) werden bei Abos nicht übernommen.
    const syncing = new Set();

    async function syncSub(url) {
        if (!state.subs[url] || syncing.has(url)) return null;
        syncing.add(url);
        try {
            state.subs[url].lastCheck = Date.now();
            let list;
            try {
                list = parseList(await fetchListText(url));
                // Eine HTML-Seite (Anmeldung, Fehlerseite) ist keine Liste. Nicht abgleichen,
                // sonst fielen alle Einträge des Abos weg.
                if (!list.users.length && list.invalid) throw new Error('Unter der Adresse steht keine Blockliste (keine gültigen Einträge)');
            } catch (e) {
                if (state.subs[url]) {
                    state.subs[url].error = clip(e.message, 200);
                    saveSubs();
                }
                throw e;
            }
            // Während des Ladens kann ein anderer Tab den Stand neu geladen haben: aktuellen nehmen
            const sub = state.subs[url];
            if (!sub) return null;
            const title = list.title || sub.title || new URL(url).hostname;
            const wanted = new Map(list.users.filter(u => !sub.excluded.includes(u.id)).map(u => [u.id, u]));
            const result = { added: 0, removed: 0, total: wanted.size, title };
            for (const [id, u] of Object.entries(state.users)) {
                if (u.sub === url && !wanted.has(id)) { delete state.users[id]; result.removed++; }
            }
            for (const [id, u] of wanted) {
                const cur = state.users[id];
                if (!cur) {
                    state.users[id] = cleanUser({ ...u, added: Date.now(), source: title, sub: url });
                    result.added++;
                } else if (cur.sub === url) {
                    state.users[id] = cleanUser({ ...u, added: cur.added, source: title, sub: url });
                }
            }
            Object.assign(sub, { title, lastSuccess: Date.now(), error: '' });
            // Erst das Abo, dann die Einträge: andere Tabs kennen das Abo, bevor sie die Einträge sehen
            saveSubs();
            saveUsers();
            refreshPage();
            return result;
        } finally {
            syncing.delete(url);
        }
    }

    // Fällige Abos nacheinander aktualisieren (beim Seitenaufruf)
    async function refreshSubs() {
        const now = Date.now();
        const due = Object.keys(state.subs)
            .filter(url => now - state.subs[url].lastCheck > CONFIG.subRefreshMs)
            .sort((a, b) => state.subs[a].lastCheck - state.subs[b].lastCheck)
            .slice(0, CONFIG.subsPerVisit);
        for (const url of due) {
            try { await syncSub(url); } catch (e) { console.warn('[Nutzer ausblenden] Abo nicht geladen:', url, e); }
        }
    }

    function removeSub(url) {
        Object.keys(state.users).forEach(id => { if (state.users[id].sub === url) delete state.users[id]; });
        delete state.subs[url];
        saveUsers();
        saveSubs();
        refreshPage();
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const blockSvg = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>`;

    const styleEl = document.createElement('style');

    // Die Seite baut Teile des Dokuments nach dem Laden neu auf; dann die Styles erneut einhängen
    function ensureStyles() {
        if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
    }

    // Ruft fn gebündelt (einmal pro Frame) auf, sobald sich das Dokument ändert.
    // Beobachtet <html> statt <body>, falls die Seite den <body> selbst austauscht.
    function watchPage(fn) {
        let scheduled = false;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; fn(); });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    function injectStyles() {
        styleEl.textContent = `
            [data-kua-hidden] { display: none !important; }
            [data-kua-state="collapsed"] > :not(.kua-note-bar) { display: none !important; }
            [data-kua-state="collapsed"] { min-height: 0 !important; height: auto !important; }
            .kua-price-row { display: flex !important; align-items: center; flex-wrap: wrap; gap: 8px; }
            .kua-wrap { margin-left: auto; display: block; }
            .kx-btn-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin: 6px 0 0; }
            .klm-price-row .klm-wrap + .kua-wrap, .kua-price-row .kua-wrap + .klm-wrap { margin-left: 0; }
            .kua-btn {
                display: inline-flex; align-items: center; gap: 5px;
                padding: 4px 10px; border-radius: 999px;
                border: 1px solid #d0d0cc; background: #fff; color: #555;
                font: inherit; font-size: 13px; font-weight: 600; line-height: 20px;
                cursor: pointer; white-space: nowrap; text-decoration: none;
                transition: background-color .15s, border-color .15s, color .15s;
            }
            .kua-btn:hover, .kua-btn:focus-visible { border-color: #1e1e1e; color: #1e1e1e; background: #f2f1ee; outline: none; }
            .kua-btn[data-state="blocked"] { border-color: #1e1e1e; background: #1e1e1e; color: #fff; }
            .kua-btn svg { flex: none; }
            /* Anzeigenseite: nie strecken (der Anbieter-Kasten ist teils ein Flex-Layout), rot abgesetzt */
            .kua-btn.kua-detail-btn {
                flex: none !important; align-self: flex-start !important; width: auto !important; height: auto !important;
                max-width: max-content; border-color: #c62828; color: #c62828; background: #fdecea;
            }
            .kua-btn.kua-detail-btn:hover, .kua-btn.kua-detail-btn:focus-visible { background: #c62828; border-color: #c62828; color: #fff; }
            .kua-btn.kua-detail-btn[data-state="blocked"] { border-color: #1e1e1e; background: #1e1e1e; color: #fff; }

            .kua-note-bar {
                display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
                padding: 8px 12px; margin: 0; border: 1px dashed #c9c7c2; border-radius: 8px;
                background: #f7f6f3; color: #555; font-size: 13px; line-height: 1.4; text-align: left;
            }
            .kua-note-bar[data-kind="revealed"] { border-style: solid; margin-bottom: 6px; }
            .kua-note-bar .kua-note-text { flex: 1 1 200px; min-width: 0; }
            .kua-note-bar button {
                padding: 2px 10px; border-radius: 999px; border: 1px solid #c9c7c2; background: #fff;
                color: #1e1e1e; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
            }
            .kua-note-bar button:hover, .kua-note-bar button:focus-visible { border-color: #1e1e1e; outline: none; }

            .kua-pill {
                position: fixed; left: 16px; bottom: 16px; z-index: 2147482500;
                display: inline-flex; align-items: center; gap: 6px;
                padding: 6px 12px; border-radius: 999px; border: 1px solid #d0d0cc;
                background: #fff; color: #1e1e1e; font: inherit; font-size: 13px; font-weight: 600;
                box-shadow: 0 4px 14px rgba(0,0,0,.15); cursor: pointer;
            }
            .kua-pill:hover, .kua-pill:focus-visible { border-color: #1e1e1e; outline: none; }

            .kua-toast, .kua-bar {
                position: fixed; left: 50%; transform: translateX(-50%);
                z-index: 2147483000; max-width: min(620px, calc(100vw - 32px)); box-sizing: border-box;
                display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px;
                padding: 10px 14px; border-radius: 10px;
                background: #1e1e1e; color: #fff; font: inherit; font-size: 14px; line-height: 1.4;
                box-shadow: 0 8px 24px rgba(0,0,0,.25);
            }
            .kua-toast { bottom: 76px; }
            .kua-bar { bottom: 16px; z-index: 2147482900; }
            .kua-toast[data-kind="ok"] { background: #2e7d32; }
            .kua-toast[data-kind="warn"] { background: #8a4b00; }
            .kua-toast-text { flex: 1 1 220px; }
            .kua-toast button, .kua-bar button {
                padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.6);
                background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer;
            }
            .kua-toast button:hover, .kua-bar button:hover { background: rgba(255,255,255,.15); }

            .kua-pop, .kua-panel {
                box-sizing: border-box; background: #fff; color: #1e1e1e;
                border: 1px solid #d0d0cc; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.22);
                font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
            }
            .kua-pop { position: absolute; z-index: 2147482000; max-height: calc(100vh - 32px); overflow: auto; }
            .kua-pop *, .kua-panel *, .kua-pop *::before, .kua-panel *::before, .kua-pop *::after, .kua-panel *::after { box-sizing: border-box; }
            .kua-overlay {
                position: fixed; inset: 0; z-index: 2147483100; background: rgba(0,0,0,.4);
                display: grid; place-items: center; padding: 16px;
            }
            .kua-panel { width: min(640px, 100%); max-height: calc(100vh - 32px); overflow: auto; }
            .kua-head {
                position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
                padding: 10px 10px 10px 14px; background: #fff; border-bottom: 1px solid #eceae6;
            }
            .kua-title { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .kua-body { padding: 12px 14px 14px; display: grid; gap: 12px; }
            .kua-section { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid #eceae6; }
            section.kua-section:first-of-type { padding-top: 0; border-top: 0; }
            .kua-section h3 { margin: 0; font-size: 15px; font-weight: 700; }
            .kua-pop button, .kua-pop input, .kua-pop textarea,
            .kua-panel button, .kua-panel input, .kua-panel textarea { font: inherit; font-size: 14px; color: inherit; }
            .kua-icon-btn {
                flex: none; width: 32px; height: 32px; display: inline-grid; place-items: center;
                border: 0; border-radius: 8px; background: transparent; cursor: pointer; font-size: 18px; line-height: 1;
            }
            .kua-icon-btn:hover, .kua-icon-btn:focus-visible { background: #f2f1ee; outline: none; }
            .kua-field { display: grid; gap: 4px; }
            .kua-field > span { font-size: 12px; font-weight: 600; color: #555; }
            .kua-input { width: 100%; padding: 8px 10px; border: 1px solid #c9c7c2; border-radius: 8px; background: #fff; }
            .kua-input:focus { outline: 2px solid #1e1e1e; outline-offset: -1px; }
            textarea.kua-input { resize: vertical; min-height: 80px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; font-size: 12px !important; }
            .kua-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
            .kua-row .kua-input { flex: 1 1 160px; width: auto; }
            .kua-spacer { flex: 1; }
            .kua-action {
                padding: 7px 14px; border-radius: 999px; border: 1px solid #c9c7c2; background: #fff;
                font-weight: 600; cursor: pointer; white-space: nowrap;
            }
            .kua-action:hover:not(:disabled), .kua-action:focus-visible { border-color: #1e1e1e; outline: none; }
            .kua-action[data-primary] { background: #1e1e1e; border-color: #1e1e1e; color: #fff; }
            .kua-action[data-primary]:hover:not(:disabled) { background: #000; }
            .kua-action[data-danger]:hover:not(:disabled) { border-color: #c62828; color: #c62828; }
            .kua-action:disabled { opacity: .45; cursor: not-allowed; }
            .kua-link { padding: 0; border: 0; background: none; color: #555; text-decoration: underline; font-size: 13px; cursor: pointer; }
            .kua-link:hover { color: #1e1e1e; }
            .kua-hint, .kua-muted { margin: 0; font-size: 12px; color: #6b6b6b; }
            .kua-note { margin: 0; padding: 8px 10px; border-radius: 8px; background: #f2f1ee; font-size: 13px; }
            .kua-note[data-kind="error"] { background: #fdecea; color: #8e1c1c; }
            .kua-note[data-kind="ok"] { background: #edf7ee; color: #1f5e23; }
            .kua-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
            .kua-check input { margin: 2px 0 0; accent-color: #1e1e1e; flex: none; }
            .kua-users { display: grid; gap: 6px; max-height: 320px; overflow: auto; }
            .kua-user { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border: 1px solid #e3e1dc; border-radius: 8px; }
            .kua-user-main { flex: 1; min-width: 0; display: grid; gap: 4px; }
            .kua-user-main a { font-weight: 600; color: inherit; overflow-wrap: anywhere; }
            .kua-user .kua-input { padding: 4px 8px; font-size: 13px; }
            .kua-preview[hidden] { display: none; }
            .kua-preview { display: grid; gap: 8px; padding: 10px; border: 1px solid #c9c7c2; border-radius: 8px; background: #faf9f7; }
            .kua-pick-list { display: grid; gap: 2px; max-height: 240px; overflow: auto; padding: 4px; border: 1px solid #e3e1dc; border-radius: 8px; background: #fff; }
            .kua-pick { padding: 4px 6px; border-radius: 6px; }
            .kua-pick:hover { background: #f2f1ee; }
            .kua-pick a { color: #555; font-size: 12px; }
            .kua-sources { display: grid; gap: 4px; padding-top: 4px; }
        `;
        ensureStyles();
    }

    // ------------------------------------------------------------------
    // Hinweise (Toast) und feste Leiste
    // ------------------------------------------------------------------

    let toastTimer = null;

    function showToast(text, kind, actions = [], autoHideMs = 0) {
        hideToast();
        const toast = el('div', { className: 'kua-ui kua-toast', role: 'status', dataset: kind ? { kind } : null },
            el('span', { className: 'kua-toast-text' }, text),
            actions.map(a => el('button', { type: 'button', onclick: a.onClick }, a.label)),
            el('button', { type: 'button', 'aria-label': 'Hinweis schließen', onclick: hideToast }, '×'));
        document.body.appendChild(toast);
        if (autoHideMs) toastTimer = setTimeout(hideToast, autoHideMs);
    }

    function hideToast() {
        clearTimeout(toastTimer);
        document.querySelectorAll('.kua-toast').forEach(t => t.remove());
    }

    function setBar(content) {
        document.querySelectorAll('.kua-bar').forEach(b => b.remove());
        if (content) document.body.appendChild(el('div', { className: 'kua-ui kua-bar', role: 'status' }, content));
    }

    // ------------------------------------------------------------------
    // Menü an einer Anzeige (Ausblenden / Blockieren)
    // ------------------------------------------------------------------

    let pop = null; // { root, btn, cleanup }

    function closePopover() {
        if (!pop) return;
        pop.cleanup();
        pop.root.remove();
        const btn = pop.btn;
        pop = null;
        if (btn.isConnected) btn.focus({ preventScroll: true });
    }

    function positionPopover() {
        const { root, btn } = pop;
        const r = btn.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const width = Math.min(380, vw - 32);
        root.style.width = width + 'px';
        const left = Math.min(Math.max(16, r.right - width), vw - 16 - width);
        const h = root.offsetHeight;
        const below = r.bottom + 8;
        const top = (below + h > vh - 8 && r.top - 8 - h > 8) ? r.top - 8 - h : below;
        root.style.left = (left + window.scrollX) + 'px';
        root.style.top = (top + window.scrollY) + 'px';
    }

    function headBar(title, onClose) {
        return el('div', { className: 'kua-head' },
            el('span', { className: 'kua-title', title }, title),
            el('button', { type: 'button', className: 'kua-icon-btn', 'aria-label': 'Schließen', title: 'Schließen', onclick: onClose }, '×'));
    }

    // info: { adId, href, title, userId?, sellerName? }
    function openPopover(info, btn) {
        if (pop && pop.btn === btn) { closePopover(); return; }
        closePopover();
        closePanel();

        const root = el('div', { className: 'kua-ui kua-pop', role: 'dialog', 'aria-label': 'Ausblenden oder blockieren' });
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
        const onOutside = (e) => { if (pop && !root.contains(e.target) && !btn.contains(e.target)) closePopover(); };
        const onResize = () => pop && positionPopover();
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('resize', onResize);
        pop = {
            root, btn,
            cleanup: () => {
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('pointerdown', onOutside, true);
                window.removeEventListener('resize', onResize);
            },
        };
        document.body.appendChild(root);

        const name = el('input', { className: 'kua-input', type: 'text', maxLength: CONFIG.nameMax, placeholder: 'Name (optional)' });
        const note = el('input', { className: 'kua-input', type: 'text', maxLength: CONFIG.noteMax, placeholder: 'z. B. Lockpreise, Betrugsverdacht' });
        const status = el('p', { className: 'kua-note', role: 'status', hidden: true });
        let resolving = false;

        const render = () => {
            if (!pop || pop.root !== root) return;
            const uid = info.userId;
            const blocked = uid && state.users[uid];
            const adHidden = info.adId && state.ads[info.adId];
            const sellerText = uid
                ? `Anbieter: ${userLabel(uid, info.sellerName)}${isShop(uid) ? ' (Shop)' : ` (ID ${uid})`}`
                : resolving ? 'Anbieter wird ermittelt …' : 'Anbieter unbekannt';

            const parts = [el('p', { className: 'kua-muted' }, sellerText)];
            if (blocked) {
                parts.push(el('p', { className: 'kua-note', dataset: { kind: 'ok' } },
                    `Blockiert seit ${fmtDate(blocked.added)}${blocked.note ? ` · ${blocked.note}` : ''}`
                    + (blocked.source ? ` · aus ${isSubEntry(blocked) ? 'Abo ' : ''}„${blocked.source}“` : '')));
                parts.push(el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }),
                    el('button', { type: 'button', className: 'kua-action', onclick: () => { unblockUser(uid); render(); } }, 'Anbieter freigeben')));
            } else {
                if (!name.value && info.sellerName) name.value = info.sellerName;
                parts.push(
                    el('label', { className: 'kua-field' }, el('span', {}, 'Name in deiner Liste'), name),
                    el('label', { className: 'kua-field' }, el('span', {}, 'Notiz (nur für dich)'), note),
                    el('div', { className: 'kua-row' },
                        el('span', { className: 'kua-spacer' }),
                        el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' }, disabled: !uid,
                            onclick: () => { blockUser(uid, name.value, note.value); closePopover(); } }, 'Anbieter blockieren')));
            }
            parts.push(status);
            if (info.adId && !isDetailPage) {
                parts.push(el('div', { className: 'kua-row' },
                    adHidden
                        ? el('button', { type: 'button', className: 'kua-link', onclick: () => { unhideAd(info.adId); closePopover(); } }, 'Diese Anzeige nicht mehr ausblenden')
                        : el('button', { type: 'button', className: 'kua-link', onclick: () => { hideAd(info.adId); closePopover(); } }, 'Nur diese Anzeige ausblenden')));
            }
            parts.push(el('div', { className: 'kua-row' },
                el('button', { type: 'button', className: 'kua-link', onclick: () => { closePopover(); openPanel(); } }, 'Blockliste verwalten …')));

            root.replaceChildren(headBar(info.title ? `Ausblenden: ${info.title}` : 'Ausblenden', closePopover),
                el('div', { className: 'kua-body' }, parts));
            positionPopover();
        };

        render();
        root.scrollIntoView({ block: 'nearest' });
        (root.querySelector('[data-primary]:not(:disabled)') || root.querySelector('.kua-icon-btn')).focus({ preventScroll: true });

        if (!info.userId && info.href) {
            resolving = true;
            render();
            resolveSeller(info).then(seller => {
                resolving = false;
                if (seller) {
                    info.userId = seller.id;
                    info.sellerName = seller.name;
                    refreshPage();
                } else {
                    setNote(status, 'Der Anbieter ließ sich auf der Anzeigenseite nicht erkennen. Du kannst die Anzeige trotzdem einzeln ausblenden.', 'error');
                }
                render();
            }).catch(() => {
                resolving = false;
                setNote(status, 'Die Anzeigenseite konnte nicht geladen werden. Du kannst die Anzeige trotzdem einzeln ausblenden.', 'error');
                render();
            });
        }
    }

    // ------------------------------------------------------------------
    // Übersicht: Karten finden, ausblenden, Buttons einfügen
    // ------------------------------------------------------------------

    function findAdCards() {
        const cards = new Set();

        // Klassisches Layout
        document.querySelectorAll('article.aditem[data-adid]').forEach(c => cards.add(c));

        // Generisch: vom Anzeigen-Link so weit nach oben laufen, wie der Container
        // nur Links auf genau diese eine Anzeige enthält -> das ist die Karte.
        document.querySelectorAll('a[href*="/s-anzeige/"]').forEach(link => {
            if (link.closest('.kua-ui, article.aditem[data-adid]')) return;
            const adId = getAdIdFromUrl(link.href);
            if (!adId) return;
            let card = null;
            let node = link.parentElement;
            while (node && node !== document.body && containsOnlyAd(node, adId)) {
                card = node;
                node = node.parentElement;
            }
            if (card) cards.add(card);
        });

        return Array.from(cards);
    }

    function containsOnlyAd(node, adId) {
        return Array.from(node.querySelectorAll('a[href*="/s-anzeige/"]'))
            .every(a => getAdIdFromUrl(a.href) === adId);
    }

    const cardInfos = new WeakMap();

    function getCardInfo(card) {
        if (cardInfos.has(card)) return cardInfos.get(card);
        const link = card.querySelector('a[href*="/s-anzeige/"]');
        const rawHref = card.dataset.href || (link ? link.getAttribute('href') : null);
        const href = rawHref ? new URL(rawHref, window.location.origin).href : null;
        const adId = card.dataset.adid || getAdIdFromUrl(href);
        if (!href || !adId) return null;
        const titleEl = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        const title = clip(titleEl ? titleEl.textContent : (link ? link.textContent : ''), 120);
        // Falls die Karte selbst auf den Anbieter verlinkt, gleich übernehmen
        const cardSeller = Array.from(card.querySelectorAll('a[href]'))
            .map(a => userIdFromHref(a.getAttribute('href'))).find(Boolean) || null;
        const info = { href, adId, title, cardSeller };
        cardInfos.set(card, info);
        return info;
    }

    // Preis-Bestandteile: "2 €", "3.399 €", "VB", "Zu verschenken", "ab"
    const pricePartsRe = /\d[\d.,]*\s*€|zu verschenken|VB|ab/gi;

    function isPriceOnly(text) {
        const t = text.trim();
        // „VB“ allein (Verhandlungsbasis ohne Betrag) zählt auch als Preis
        return t.length > 0 && (/€|zu verschenken/i.test(t) || /^vb$/i.test(t)) && t.replace(pricePartsRe, '').replace(/\s+/g, '') === '';
    }

    // Buttons dieses und anderer Scripts (Anzeige melden, Superscript) beim Lesen des Preises
    // ignorieren. Sonst findet das zweite Script die Preiszeile nicht mehr, sobald das erste seinen
    // Button hineingesetzt hat, und setzt keinen Button.
    const FOREIGN_UI = '.kua-ui, .klm-wrap, .kps-ui, .kss-ui';

    function textWithoutUi(node) {
        let text = node.textContent;
        node.querySelectorAll(FOREIGN_UI).forEach(ui => { text = text.split(ui.textContent).join(''); });
        return text;
    }

    function findPriceRow(card) {
        const classic = card.querySelector('.aditem-main--middle--price-shipping');
        if (classic) return classic;
        // Erstes reines Preis-Element: keine Kind-Elemente außer fremden Buttons, nur Preistext
        const first = Array.from(card.querySelectorAll('p, span, div, strong, b'))
            .find(n => Array.from(n.children).every(c => c.matches(FOREIGN_UI))
                && !n.closest(FOREIGN_UI) && isPriceOnly(textWithoutUi(n)));
        if (!first) return null;
        let row = first;
        while (row.parentElement && row.parentElement !== card && isPriceOnly(textWithoutUi(row.parentElement))) {
            row = row.parentElement;
        }
        return row;
    }

    // Rückfall ohne Preiszeile (z. B. „VB“ ohne Betrag oder „Zu verschenken“ auf der Startseite,
    // wo die Karte dann keinen Preis zeigt): eigene Button-Zeile unter dem Titel. Die Zeile
    // (.kx-btn-row) teilen sich „Anzeige melden“ und „Nutzer ausblenden“, damit beide Buttons
    // nebeneinander stehen.
    function buttonRowFallback(card) {
        const existing = card.querySelector('.kx-btn-row');
        if (existing) return existing;
        const title = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        if (!title) return null;
        const link = title.closest('a');
        const anchor = link && link !== card && card.contains(link) ? link : title;
        const row = document.createElement('div');
        row.className = 'kx-btn-row';
        anchor.insertAdjacentElement('afterend', row);
        return row;
    }

    // Beim Ganz-Ausblenden auch das umgebende <li> ausblenden, sonst bleiben Lücken
    function hideTarget(card, adId) {
        const li = card.parentElement && card.parentElement.closest('li');
        return li && li !== card && containsOnlyAd(li, adId) ? li : card;
    }

    const revealed = new Set(); // in dieser Sitzung vorübergehend eingeblendete Anzeigen

    function cardButton(info) {
        const btn = guardedButton({ className: 'kua-btn', title: 'Anzeige oder Anbieter ausblenden',
            onclick: () => openPopover(info, btn) });
        btn.innerHTML = `${blockSvg}<span>Ausblenden</span>`;
        return btn;
    }

    function noteBar(kind, text, actions) {
        const bar = el('div', { className: 'kua-ui kua-note-bar', dataset: { kind } },
            el('span', { className: 'kua-note-text' }, text),
            actions.map(a => guardedButton({ onclick: a.onClick }, a.label)));
        guard(bar);
        return bar;
    }

    function applyCard(card) {
        const info = getCardInfo(card);
        if (!info) return null;
        if (info.cardSeller) learn(info.adId, info.cardSeller);
        info.userId = info.cardSeller || state.index[info.adId] || null;

        let reason = null;
        if (info.userId && state.users[info.userId] && info.userId !== pageSellerId) reason = 'user';
        else if (state.ads[info.adId]) reason = 'ad';

        const mode = !reason ? 'visible' : revealed.has(info.adId) ? 'revealed' : state.settings.mode === 'hide' ? 'hidden' : 'collapsed';
        const label = reason === 'user' ? userLabel(info.userId) : '';
        const sig = [mode, reason, info.userId, label].join('|');

        // Button neben dem Preis – erneut einsetzen, falls die Seite die Karte neu aufgebaut hat
        const wrap = card.querySelector(':scope .kua-wrap');
        if (!wrap) {
            const row = findPriceRow(card) || buttonRowFallback(card);
            if (row) {
                row.classList.add('kua-price-row');
                row.appendChild(el('span', { className: 'kua-ui kua-wrap' }, cardButton(info)));
            }
        } else if (!wrap.parentElement.classList.contains('kua-price-row')) {
            wrap.parentElement.classList.add('kua-price-row');
        }

        // Neu zeichnen, wenn sich der Zustand geändert hat oder die Seite unsere Änderungen entfernt hat
        const bar = card.querySelector(':scope > .kua-note-bar');
        const intact = card.dataset.kuaSig === sig
            && (card.dataset.kuaState || 'visible') === (mode === 'hidden' ? 'visible' : mode)
            && !!bar === (mode === 'collapsed' || mode === 'revealed')
            && hideTarget(card, info.adId).hasAttribute('data-kua-hidden') === (mode === 'hidden');
        if (!intact) {
            card.dataset.kuaSig = sig;
            card.removeAttribute('data-kua-state');
            hideTarget(card, info.adId).removeAttribute('data-kua-hidden');
            card.querySelectorAll(':scope > .kua-note-bar').forEach(b => b.remove());

            const unblock = reason === 'user'
                ? { label: 'Anbieter freigeben', onClick: () => unblockUser(info.userId) }
                : { label: 'Nicht mehr ausblenden', onClick: () => unhideAd(info.adId) };
            const what = reason === 'user' ? `Anzeige von „${label}“ (blockiert)` : `„${info.title || 'Anzeige ' + info.adId}“`;

            if (mode === 'hidden') {
                hideTarget(card, info.adId).setAttribute('data-kua-hidden', '');
            } else if (mode === 'collapsed') {
                card.dataset.kuaState = 'collapsed';
                card.prepend(noteBar('collapsed', `Ausgeblendet: ${what}`, [
                    { label: 'Kurz zeigen', onClick: () => { revealed.add(info.adId); refreshPage(); } },
                    unblock,
                ]));
            } else if (mode === 'revealed') {
                card.dataset.kuaState = 'revealed';
                card.prepend(noteBar('revealed', reason === 'user' ? `Von „${label}“ (blockiert)` : 'Von dir ausgeblendet', [
                    { label: 'Wieder einklappen', onClick: () => { revealed.delete(info.adId); refreshPage(); } },
                    unblock,
                ]));
            }
        }
        return { info, mode };
    }

    let pill = null;

    function updatePill(hiddenCount) {
        if (!pill) pill = el('button', { type: 'button', className: 'kua-ui kua-pill', onclick: () => openPanel() });
        if (!pill.isConnected) document.body.appendChild(pill);
        const text = hiddenCount ? `${hiddenCount} ausgeblendet` : 'Blockliste';
        if (pill.dataset.text !== text) {
            pill.dataset.text = text;
            pill.innerHTML = blockSvg;
            pill.append(el('span', {}, text));
            pill.title = 'Blockliste verwalten';
        }
    }

    // Unbekannte Anbieter im Hintergrund ermitteln (nur, wenn eingeschaltet)
    const resolveQueue = [];
    const queued = new Set();
    let resolveBusy = false;

    async function pumpResolveQueue() {
        if (resolveBusy) return;
        resolveBusy = true;
        try {
            while (resolveQueue.length && state.settings.autoResolve) {
                const info = resolveQueue.shift();
                if (!state.index[info.adId]) {
                    try { await resolveSeller(info); } catch (e) { /* nächste */ }
                    refreshPage();
                    await sleep(CONFIG.requestGapMs);
                }
            }
        } finally {
            resolveBusy = false;
        }
    }

    function applyOverview() {
        ensureStyles();
        let hiddenCount = 0;
        for (const card of findAdCards()) {
            const res = applyCard(card);
            if (!res) continue;
            if (res.mode === 'hidden' || res.mode === 'collapsed') hiddenCount++;
            if (!res.info.userId && state.settings.autoResolve && !queued.has(res.info.adId) && queued.size < CONFIG.autoResolveMax) {
                queued.add(res.info.adId);
                resolveQueue.push(res.info);
            }
        }
        flushIndex();
        updatePill(hiddenCount);
        if (resolveQueue.length) pumpResolveQueue();
        if (isSellerPage) renderSellerBar();
    }

    function renderSellerBar() {
        if (!pageSellerId) return;
        const blocked = state.users[pageSellerId];
        const key = blocked ? 'b' : 'u';
        const bar = document.querySelector('.kua-bar');
        if (bar && bar.dataset.key === key) return;
        const info = { adId: null, href: null, title: userLabel(pageSellerId), userId: pageSellerId };
        const btn = el('button', { type: 'button' }, blocked ? 'Freigeben' : 'Anbieter blockieren');
        btn.addEventListener('click', () => (blocked ? unblockUser(pageSellerId) : openPopover(info, btn)));
        setBar([
            el('span', { className: 'kua-toast-text' }, blocked
                ? `Diesen Anbieter hast du blockiert (seit ${fmtDate(blocked.added)}). Seine Anzeigen werden in der Suche ausgeblendet.`
                : 'Bestandsliste dieses Anbieters.'),
            btn,
            el('button', { type: 'button', onclick: () => openPanel() }, 'Blockliste'),
        ]);
        document.querySelector('.kua-bar').dataset.key = key;
    }

    function runOverview() {
        // Auf der Bestandsliste gehören alle Anzeigen der Liste zu diesem Anbieter
        if (pageSellerId) mainListAdIds(document).forEach(adId => learn(adId, pageSellerId));

        refreshPage = () => { closeStalePopover(); applyOverview(); };
        applyOverview();
        watchPage(applyOverview);

        setTimeout(() => refreshSubs().then(refreshBlockedSellers), 3000);
    }

    // Das Menü bleibt offen, solange sein Button noch auf der Seite ist
    function closeStalePopover() {
        if (pop && !pop.btn.isConnected) closePopover();
    }

    // ------------------------------------------------------------------
    // Anzeigenseite
    // ------------------------------------------------------------------

    // Der Anbieter-Kasten kann nach dem Laden noch nachgerendert werden: kurz darauf warten
    function runDetail() {
        if (findSeller(document)) { setupDetail(); return; }
        const obs = new MutationObserver(() => {
            if (!findSeller(document)) return;
            obs.disconnect();
            clearTimeout(timer);
            setupDetail();
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        const timer = setTimeout(() => obs.disconnect(), 15000);
    }

    function setupDetail() {
        const adId = getAdIdFromUrl(window.location.href);
        const seller = findSeller(document);
        if (!seller) return;
        learn(adId, seller.id);
        flushIndex();

        const h1 = document.querySelector('#viewad-title, h1');
        const info = {
            adId, href: window.location.href.split('#')[0],
            title: clip(h1 ? h1.textContent : '', 120),
            userId: seller.id, sellerName: seller.name,
        };

        // Zwei Bedienelemente: ein Button am Anbieter-Namen und ein fester Button unten links.
        // Der feste Button hängt direkt am <body> und funktioniert auch dann, wenn die Seite
        // den Anbieter-Kasten neu aufbaut und den Button dort wieder entfernt.
        const btn = guardedButton({ className: 'kua-ui kua-btn kua-detail-btn', style: 'margin-left:8px;vertical-align:middle',
            onclick: () => openPopover(info, btn) });
        const fab = el('button', { type: 'button', className: 'kua-ui kua-pill', onclick: () => openPopover(info, fab) });
        let barClosed = false;
        let reinserts = 0;

        const paint = () => {
            const blocked = state.users[seller.id];
            const label = blocked ? 'Blockiert' : 'Blockieren';
            btn.dataset.state = blocked ? 'blocked' : 'idle';
            btn.innerHTML = `${blockSvg}<span>${label}</span>`;
            btn.title = blocked ? 'Du hast diesen Anbieter blockiert' : 'Diesen Anbieter blockieren';
            fab.innerHTML = blockSvg;
            fab.append(el('span', {}, blocked ? 'Anbieter blockiert' : 'Anbieter blockieren'));
            fab.title = btn.title;
            setBar(blocked && !barClosed ? [
                el('span', { className: 'kua-toast-text' }, `Diese Anzeige stammt von „${userLabel(seller.id, seller.name)}“, den du blockiert hast.`),
                el('button', { type: 'button', onclick: () => unblockUser(seller.id) }, 'Freigeben'),
                el('button', { type: 'button', onclick: () => openPanel() }, 'Blockliste'),
                el('button', { type: 'button', 'aria-label': 'Hinweis schließen', onclick: () => { barClosed = true; setBar(null); } }, '×'),
            ] : null);
        };

        // Fehlt etwas (Styles, Buttons, Leiste), wieder einsetzen. Entfernt die Seite den Button
        // am Namen immer wieder, wird es nach 20 Versuchen dort aufgegeben (der feste Button bleibt).
        const ensure = () => {
            ensureStyles();
            if (!fab.isConnected) document.body.appendChild(fab);
            if (!btn.isConnected && reinserts < 20) {
                const again = findSeller(document);
                if (again && again.id === seller.id) {
                    again.el.insertAdjacentElement('afterend', btn);
                    reinserts++;
                }
            }
            if (state.users[seller.id] && !barClosed && !document.querySelector('.kua-bar')) paint();
        };

        seller.el.insertAdjacentElement('afterend', btn);
        refreshPage = () => { closeStalePopover(); paint(); ensure(); };
        refreshPage();
        watchPage(ensure);
    }

    // ------------------------------------------------------------------
    // Blockliste: Export / Import
    // ------------------------------------------------------------------

    // Exportiert wird nur die eigene Liste (inkl. zusammengeführter Listen), keine Abo-Einträge
    const ownUsers = () => Object.entries(state.users).filter(([, u]) => !isSubEntry(u));

    function exportJson() {
        const users = ownUsers()
            .sort((a, b) => a[1].added - b[1].added)
            .map(([id, u]) => ({ id, name: u.name, note: u.note, added: new Date(u.added).toISOString(), ...(u.source ? { source: u.source } : {}) }));
        return JSON.stringify({
            format: CONFIG.listFormat,
            version: CONFIG.listFormatVersion,
            title: 'Meine Kleinanzeigen-Blockliste',
            exported: new Date().toISOString(),
            users,
            ads: Object.keys(state.ads),
        }, null, 2) + '\n';
    }

    function exportText() {
        const lines = [
            '! Titel: Meine Kleinanzeigen-Blockliste',
            `! Format: ${CONFIG.listFormat} ${CONFIG.listFormatVersion}`,
            `! Exportiert: ${new Date().toISOString()}`,
            '# Eine Zeile pro Anbieter: <Nutzer-ID> [Name] [# Notiz]',
            '# Einzelne Anzeigen: anzeige:<Anzeigen-Nr>',
        ];
        ownUsers()
            .sort((a, b) => a[1].added - b[1].added)
            .forEach(([id, u]) => {
                let line = id;
                if (u.name) line += ' ' + u.name.replace(/#/g, '');
                if (u.note) line += '  # ' + u.note;
                lines.push(line);
            });
        Object.keys(state.ads).forEach(adId => lines.push(`anzeige:${adId}`));
        return lines.join('\n') + '\n';
    }

    // Liest JSON- oder Textlisten. Liefert { title, users: [{id,name,note,added,source?}], ads: [], invalid }.
    // Mehrfach vorkommende Anbieter/Anzeigen werden nur einmal übernommen.
    function parseList(input) {
        const text = String(input || '').replace(/^\uFEFF/, '').trim();
        const out = { title: '', users: [], ads: [], invalid: 0 };
        const seenUsers = new Set();
        const seenAds = new Set();
        const pushUser = (id, entry) => {
            if (seenUsers.has(id)) return;
            seenUsers.add(id);
            // "sub" setzt nur der Abgleich eines Abos, nie die Liste selbst (sonst wäre der
            // Eintrag nach dem Import unsichtbar)
            const user = cleanUser(entry);
            delete user.sub;
            out.users.push({ id, ...user });
        };
        const addUser = (raw) => {
            const entry = typeof raw === 'string' ? { id: raw } : raw;
            const id = isObj(entry) ? normalizeUserId(entry.id) : null;
            if (!id) { out.invalid++; return; }
            pushUser(id, entry);
        };
        const addAd = (raw) => {
            const adId = /^\d{1,15}$/.test(String(raw)) ? String(raw) : getAdIdFromUrl(raw);
            if (!adId) { out.invalid++; return; }
            if (!seenAds.has(adId)) { seenAds.add(adId); out.ads.push(adId); }
        };

        if (text.startsWith('{') || text.startsWith('[')) {
            let data;
            try { data = JSON.parse(text); } catch (e) { throw new Error('Die JSON-Datei ist fehlerhaft.'); }
            if (Array.isArray(data)) data = { users: data };
            if (!isObj(data)) throw new Error('Unbekanntes Format.');
            if (data.format && data.format !== CONFIG.listFormat) throw new Error(`Unbekanntes Listenformat „${String(data.format).slice(0, 40)}“.`);
            out.title = clip(data.title, 120);
            (Array.isArray(data.users) ? data.users : []).forEach(addUser);
            (Array.isArray(data.ads) ? data.ads : []).forEach(addAd);
            return out;
        }

        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line.startsWith('!')) {
                const m = line.match(/^!\s*(?:titel|title)\s*:\s*(.+)$/i);
                if (m) out.title = clip(m[1], 120);
                continue;
            }
            if (line.startsWith('#')) continue;
            const hash = line.indexOf('#');
            const main = (hash >= 0 ? line.slice(0, hash) : line).trim();
            const note = hash >= 0 ? line.slice(hash + 1).trim() : '';
            const token = main.split(/\s+/)[0];
            const adMatch = token.match(/^anzeige:(\d{1,15})$/i);
            if (adMatch || getAdIdFromUrl(token)) { addAd(adMatch ? adMatch[1] : token); continue; }
            const id = normalizeUserId(token);
            if (!id) { out.invalid++; continue; }
            pushUser(id, { name: main.slice(token.length), note });
        }
        return out;
    }

    // Führt eine Liste mit der eigenen zusammen (oder ersetzt sie).
    // opts: { replace, selected: Set der zu übernehmenden IDs, includeAds, source }
    // Vorhandene Einträge bleiben unverändert; nur leerer Name/leere Notiz werden ergänzt.
    function importList(list, opts = {}) {
        const result = { added: 0, existing: 0, ads: 0 };
        if (opts.replace) {
            // Ersetzt wird nur die eigene Liste; Einträge aus Abos bleiben
            Object.keys(state.users).forEach(id => { if (!isSubEntry(state.users[id])) delete state.users[id]; });
            state.ads = {};
        }
        const source = clip(opts.source, CONFIG.sourceMax);
        for (const u of list.users) {
            const cur = state.users[u.id];
            if (cur) {
                result.existing++;
                if (!cur.name && u.name) cur.name = u.name;
                if (!cur.note && u.note) cur.note = u.note;
            } else if (!opts.selected || opts.selected.has(u.id)) {
                state.users[u.id] = cleanUser({ ...u, source: source || u.source });
                result.added++;
            }
        }
        if (opts.includeAds !== false) {
            for (const adId of list.ads) {
                if (!state.ads[adId]) { state.ads[adId] = Date.now(); result.ads++; }
            }
        }
        saveUsers();
        saveAds();
        refreshPage();
        return result;
    }

    function download(filename, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = el('a', { href: url, download: filename, style: 'display:none' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            const ta = el('textarea', { value: text, style: 'position:fixed;left:-9999px;top:0' });
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
            ta.remove();
            return ok;
        }
    }

    // ------------------------------------------------------------------
    // Verwaltung (Dialog)
    // ------------------------------------------------------------------

    let panel = null; // { overlay, box, note, preview, cleanup }

    function closePanel() {
        if (!panel) return;
        panel.cleanup();
        panel.overlay.remove();
        panel = null;
    }

    function openPanel() {
        closePopover();
        closePanel();
        const box = el('div', { className: 'kua-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Blockliste' });
        const overlay = el('div', { className: 'kua-ui kua-overlay' }, box);
        overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closePanel(); });
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } };
        document.addEventListener('keydown', onKey, true);
        panel = { overlay, box, note: null, preview: null, cleanup: () => document.removeEventListener('keydown', onKey, true) };
        document.body.appendChild(overlay);
        renderPanel();
        const first = box.querySelector('input');
        if (first) first.focus();
    }

    function renderPanel() {
        if (!panel) return;
        const { box } = panel;
        const scrollTop = box.scrollTop;
        const ids = Object.keys(state.users).filter(id => !isSubEntry(state.users[id]));
        const adCounts = {};
        Object.values(state.index).forEach(uid => { if (state.users[uid]) adCounts[uid] = (adCounts[uid] || 0) + 1; });

        // --- Anbieter hinzufügen
        const addId = el('input', { className: 'kua-input', type: 'text', placeholder: 'Nutzer-ID oder Link zum Anbieter', 'aria-label': 'Nutzer-ID oder Link zum Anbieter' });
        const addName = el('input', { className: 'kua-input', type: 'text', maxLength: CONFIG.nameMax, placeholder: 'Name (optional)', 'aria-label': 'Name' });
        const addStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });
        const doAdd = () => {
            const id = normalizeUserId(addId.value);
            if (!id) {
                setNote(addStatus, 'Keine gültige Nutzer-ID. Erwartet wird z. B. 12345678, ein Link wie …/s-bestandsliste.html?userId=12345678 oder ein Shop-Link wie …/pro/shop-name.', 'error');
                return;
            }
            if (state.users[id]) {
                setNote(addStatus, `„${userLabel(id)}“ ist bereits blockiert.`, 'ok');
                return;
            }
            blockUser(id, addName.value, '');
            renderPanel();
        };
        addId.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });

        // --- Liste
        const filter = el('input', { className: 'kua-input', type: 'search', placeholder: 'Liste durchsuchen', 'aria-label': 'Liste durchsuchen' });
        const listBox = el('div', { className: 'kua-users' });
        const drawList = () => {
            const q = filter.value.trim().toLowerCase();
            const rows = ids
                .filter(id => state.users[id])
                .sort((a, b) => state.users[b].added - state.users[a].added)
                .filter(id => !q || [id, state.users[id].name, state.users[id].note, state.users[id].source].join(' ').toLowerCase().includes(q))
                .map(id => {
                    const u = state.users[id];
                    const noteInput = el('input', { className: 'kua-input', type: 'text', value: u.note, maxLength: CONFIG.noteMax,
                        placeholder: 'Notiz', 'aria-label': `Notiz zu ${userLabel(id)}`,
                        onchange: (e) => { if (state.users[id]) { state.users[id].note = clip(e.target.value, CONFIG.noteMax); saveUsers(); } } });
                    const known = adCounts[id] || 0;
                    return el('div', { className: 'kua-user' },
                        el('div', { className: 'kua-user-main' },
                            el('a', { href: CONFIG.sellerUrl(id), target: '_blank', rel: 'noopener' }, userLabel(id)),
                            el('span', { className: 'kua-muted' },
                                `${isShop(id) ? 'Shop' : 'ID ' + id} · seit ${fmtDate(u.added)} · ${known} bekannte Anzeige${known === 1 ? '' : 'n'}`
                                + (state.scanned[id] ? ` · ${sellerPageName(id)} geprüft ${fmtDate(state.scanned[id])}` : '')
                                + (u.source ? ` · aus „${u.source}“` : '')),
                            noteInput),
                        el('button', { type: 'button', className: 'kua-action', dataset: { danger: '' },
                            onclick: () => { unblockUser(id); renderPanel(); } }, 'Freigeben'));
                });
            listBox.replaceChildren(...(rows.length ? rows : [el('p', { className: 'kua-hint' },
                ids.length ? 'Keine Treffer.' : 'Noch niemand blockiert. Nutze „Ausblenden“ an einer Anzeige oder füge oben eine Nutzer-ID hinzu.')]));
        };
        filter.addEventListener('input', drawList);
        drawList();

        // --- Einzelne Anzeigen
        const hiddenAds = Object.keys(state.ads).length;

        // --- Einstellungen
        const setting = (key, value) => { state.settings[key] = value; saveSettings(); refreshPage(); };
        const modeRadio = (value, text) => el('label', { className: 'kua-check' },
            el('input', { type: 'radio', name: 'kua-mode', value, checked: state.settings.mode === value,
                onchange: () => setting('mode', value) }), el('span', {}, text));
        const checkbox = (key, text) => el('label', { className: 'kua-check' },
            el('input', { type: 'checkbox', checked: state.settings[key], onchange: (e) => setting(key, e.target.checked) }),
            el('span', {}, text));

        // --- Liste hinzufügen: erst prüfen (Vorschau mit Auswahl), dann zusammenführen
        const importText = el('textarea', { className: 'kua-input', rows: 4, spellcheck: false,
            placeholder: 'Liste hier einfügen (JSON oder eine Nutzer-ID pro Zeile)', 'aria-label': 'Liste zum Hinzufügen' });
        const ioStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });
        const showIo = (msg, kind) => setNote(ioStatus, msg, kind);
        const startPreview = (text, fallbackTitle) => {
            let list;
            try { list = parseList(text); } catch (e) { showIo(e.message, 'error'); return; }
            if (!list.users.length && !list.ads.length) {
                showIo(`Keine Einträge gefunden${list.invalid ? ` (${list.invalid} ungültige Zeilen)` : ''}.`, 'error');
                return;
            }
            panel.preview = {
                list,
                source: list.title || fallbackTitle || 'Importierte Liste',
                selected: new Set(list.users.filter(u => !state.users[u.id]).map(u => u.id)),
                includeAds: true,
                replace: false,
            };
            panel.note = null;
            renderPanel();
            const target = panel.box.querySelector('.kua-preview');
            if (target) target.scrollIntoView({ block: 'nearest' });
        };
        const fileInput = el('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: true,
            onchange: async (e) => {
                const file = e.target.files && e.target.files[0];
                e.target.value = ''; // dieselbe Datei lässt sich so erneut wählen
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) { showIo('Die Datei ist zu groß (max. 2 MB).', 'error'); return; }
                startPreview(await file.text(), file.name.replace(/\.(json|txt)$/i, ''));
            } });

        const previewBox = el('div', { className: 'kua-preview', hidden: true });
        const drawPreview = () => {
            const pv = panel.preview;
            previewBox.hidden = !pv;
            if (!pv) { previewBox.replaceChildren(); return; }
            const { list } = pv;
            // Beim Hinzufügen nur Anbieter zur Auswahl stellen, die noch nicht in der Liste sind
            const candidates = pv.replace ? list.users : list.users.filter(u => !state.users[u.id]);
            const known = list.users.length - candidates.length;
            const summary = `${list.title ? `„${list.title}“: ` : ''}${list.users.length} Anbieter`
                + (pv.replace ? '' : ` (${candidates.length} neu, ${known} schon in deiner Liste)`)
                + (list.ads.length ? `, ${list.ads.length} einzelne Anzeige${list.ads.length === 1 ? '' : 'n'}` : '')
                + (list.invalid ? `, ${list.invalid} ungültige Zeile${list.invalid === 1 ? '' : 'n'} übersprungen` : '') + '.';

            const mergeBtn = el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' } });
            const updateMergeBtn = () => {
                const n = candidates.filter(u => pv.selected.has(u.id)).length;
                mergeBtn.textContent = pv.replace ? `Liste ersetzen (${n} Anbieter)` : `${n} Anbieter hinzufügen`;
                mergeBtn.disabled = !n && !(pv.includeAds && list.ads.length);
            };
            const select = (all) => {
                candidates.forEach(u => (all ? pv.selected.add(u.id) : pv.selected.delete(u.id)));
                drawPreview();
            };
            const rows = candidates.map(u => el('label', { className: 'kua-check kua-pick' },
                el('input', { type: 'checkbox', checked: pv.selected.has(u.id),
                    onchange: (e) => { if (e.target.checked) pv.selected.add(u.id); else pv.selected.delete(u.id); updateMergeBtn(); } }),
                el('span', {},
                    el('strong', {}, userLabel(u.id, u.name)),
                    ` · ${isShop(u.id) ? 'Shop' : 'ID ' + u.id}${u.note ? ` · ${u.note}` : ''} `,
                    el('a', { href: CONFIG.sellerUrl(u.id), target: '_blank', rel: 'noopener' }, 'ansehen'))));
            const modeRadio = (replace, text) => el('label', { className: 'kua-check' },
                el('input', { type: 'radio', name: 'kua-merge-mode', checked: pv.replace === replace,
                    onchange: () => {
                        pv.replace = replace;
                        pv.selected = new Set((replace ? list.users : list.users.filter(u => !state.users[u.id])).map(u => u.id));
                        drawPreview();
                    } }),
                el('span', {}, text));

            mergeBtn.addEventListener('click', () => {
                if (pv.replace && !window.confirm('Deine bisherige Blockliste wird vollständig durch diese Liste ersetzt. Fortfahren?')) return;
                const r = importList(list, { replace: pv.replace, selected: pv.selected, includeAds: pv.includeAds,
                    source: pv.replace ? '' : pv.source });
                panel.preview = null;
                renderPanel();
                const name = pv.replace ? list.title : (clip(pv.source, CONFIG.sourceMax) || list.title);
                showPanelNote(`${pv.replace ? 'Liste ersetzt' : 'Liste zusammengeführt'}${name ? ` („${name}“)` : ''}: `
                    + `${r.added} Anbieter hinzugefügt${r.existing ? `, ${r.existing} ${r.existing === 1 ? 'war' : 'waren'} schon in deiner Liste` : ''}`
                    + `${r.ads ? `, ${r.ads} einzelne Anzeige${r.ads === 1 ? '' : 'n'}` : ''}.`
                    + (r.added ? ` Die Anzeigen der neuen Anbieter werden nach und nach eingelesen (bis zu ${CONFIG.refreshPerVisit} Anbieter pro Seitenaufruf).` : ''), 'ok');
                if (r.added) refreshBlockedSellers().then(() => renderPanel());
            });

            // replaceChildren() setzt null als Text "null" ein, darum vorher herausfiltern
            previewBox.replaceChildren(...[
                el('p', { className: 'kua-note' }, summary),
                modeRadio(false, 'Zu meiner Liste hinzufügen (empfohlen): deine Einträge bleiben, nur neue Anbieter kommen dazu'),
                modeRadio(true, 'Meine Liste ersetzen: die bisherige Blockliste wird gelöscht'),
                pv.replace ? null : el('label', { className: 'kua-field' },
                    el('span', {}, 'Herkunft (wird bei den neuen Einträgen vermerkt, damit du sie später gemeinsam entfernen kannst)'),
                    el('input', { className: 'kua-input', type: 'text', value: pv.source, maxLength: CONFIG.sourceMax,
                        oninput: (e) => { pv.source = e.target.value; } })),
                candidates.length ? el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer kua-muted' }, pv.replace ? 'Anbieter der Liste' : 'Neue Anbieter'),
                    el('button', { type: 'button', className: 'kua-link', onclick: () => select(true) }, 'Alle'),
                    el('button', { type: 'button', className: 'kua-link', onclick: () => select(false) }, 'Keine')) : null,
                candidates.length ? el('div', { className: 'kua-pick-list' }, rows)
                    : el('p', { className: 'kua-hint' }, 'Alle Anbieter dieser Liste sind schon in deiner Liste.'),
                list.ads.length ? el('label', { className: 'kua-check' },
                    el('input', { type: 'checkbox', checked: pv.includeAds, onchange: (e) => { pv.includeAds = e.target.checked; updateMergeBtn(); } }),
                    el('span', {}, `${list.ads.length} einzeln ausgeblendete Anzeige${list.ads.length === 1 ? '' : 'n'} übernehmen`)) : null,
                el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }),
                    el('button', { type: 'button', className: 'kua-action', onclick: () => { panel.preview = null; drawPreview(); } }, 'Abbrechen'),
                    mergeBtn),
            ].filter(Boolean));
            updateMergeBtn();
        };
        drawPreview();

        // --- Übernommene Listen (Herkunft) mit "Alle freigeben"
        const sources = {};
        ids.forEach(id => { const src = state.users[id].source; if (src) sources[src] = (sources[src] || 0) + 1; });
        const removeSource = (src) => {
            let n = 0;
            // Nur übernommene Einträge; ein Abo mit gleichem Namen bleibt unberührt
            Object.keys(state.users).forEach(id => {
                const u = state.users[id];
                if (u.source === src && !isSubEntry(u)) { delete state.users[id]; n++; }
            });
            saveUsers();
            refreshPage();
            renderPanel();
            showPanelNote(`${n} Anbieter aus „${src}“ freigegeben.`, 'ok');
        };
        const sourcesBox = Object.keys(sources).length ? el('div', { className: 'kua-sources' },
            el('span', { className: 'kua-muted' }, 'Übernommene Listen:'),
            Object.entries(sources).sort((a, b) => b[1] - a[1]).map(([src, n]) => el('div', { className: 'kua-row' },
                el('span', { className: 'kua-spacer' }, `„${src}“ · ${n} Anbieter`),
                el('button', { type: 'button', className: 'kua-action', dataset: { danger: '' },
                    onclick: () => {
                        if (!window.confirm(`Alle ${n} Anbieter aus „${src}“ freigeben? Deine eigenen Einträge bleiben erhalten.`)) return;
                        removeSource(src);
                    } }, 'Alle freigeben')))) : null;
        // --- Abonnierte Listen
        const subUrl = el('input', { className: 'kua-input', type: 'url', placeholder: 'https://… (Adresse der Liste)', 'aria-label': 'Adresse der Liste' });
        const subStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });
        const subCounts = {};
        Object.values(state.users).forEach(u => { if (isSubEntry(u)) subCounts[u.sub] = (subCounts[u.sub] || 0) + 1; });
        const subResultText = (r) => `„${r.title}“: ${r.total} Anbieter in der Liste`
            + (r.added || r.removed ? ` (${r.added} neu, ${r.removed} entfernt)` : ', keine Änderungen') + '.';
        const doSubscribe = async () => {
            const url = normalizeListUrl(subUrl.value);
            if (!url) { setNote(subStatus, 'Bitte eine vollständige https-Adresse angeben, z. B. https://raw.githubusercontent.com/…/liste.txt.', 'error'); return; }
            if (state.subs[url]) { setNote(subStatus, 'Diese Liste ist bereits abonniert.', 'ok'); return; }
            state.subs[url] = { title: '', added: Date.now(), lastCheck: 0, lastSuccess: 0, error: '', excluded: [] };
            // Gleich speichern: lädt ein anderer Tab währenddessen den Stand neu, bleibt das Abo erhalten
            saveSubs();
            setNote(subStatus, 'Liste wird geladen …');
            try {
                const r = await syncSub(url);
                renderPanel();
                if (!r) return;
                showPanelNote(`Abonniert: ${subResultText(r)}`
                    + (r.added ? ` Die Anzeigen der neuen Anbieter werden nach und nach eingelesen (bis zu ${CONFIG.refreshPerVisit} Anbieter pro Seitenaufruf).` : ''), 'ok');
                if (r.added) refreshBlockedSellers().then(() => renderPanel());
            } catch (e) {
                delete state.subs[url];
                saveSubs();
                setNote(subStatus, `Die Liste konnte nicht geladen werden: ${e.message}. Nichts wurde abonniert.`, 'error');
            }
        };
        subUrl.addEventListener('keydown', e => { if (e.key === 'Enter') doSubscribe(); });
        const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'nie');
        const subRows = Object.entries(state.subs).sort((a, b) => a[1].added - b[1].added).map(([url, sub]) => {
            const n = subCounts[url] || 0;
            const update = async () => {
                try {
                    const r = await syncSub(url);
                    renderPanel();
                    if (r) showPanelNote(`Aktualisiert: ${subResultText(r)}`, 'ok');
                    if (r && r.added) refreshBlockedSellers().then(() => renderPanel());
                } catch (e) {
                    renderPanel();
                    showPanelNote(`„${sub.title || url}“ konnte nicht geladen werden: ${e.message}.`, 'error');
                }
            };
            return el('div', { className: 'kua-user' },
                el('div', { className: 'kua-user-main' },
                    el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, sub.title || url),
                    el('span', { className: 'kua-muted' }, `${n} Anbieter · zuletzt aktualisiert ${fmtTime(sub.lastSuccess)}`
                        + (sub.excluded.length ? ` · ${sub.excluded.length} Ausnahme${sub.excluded.length === 1 ? '' : 'n'}` : '')),
                    sub.error ? el('span', { className: 'kua-muted', style: 'color:#8e1c1c' }, `Letzter Abruf fehlgeschlagen: ${sub.error}`) : null,
                    sub.excluded.length ? el('button', { type: 'button', className: 'kua-link', style: 'justify-self:start',
                        onclick: () => { sub.excluded = []; saveSubs(); update(); } }, 'Ausnahmen zurücksetzen') : null),
                el('div', { className: 'kua-row', style: 'flex-direction:column;align-items:stretch;gap:4px' },
                    el('button', { type: 'button', className: 'kua-action', onclick: update }, 'Aktualisieren'),
                    el('button', { type: 'button', className: 'kua-action', dataset: { danger: '' },
                        onclick: () => {
                            if (!window.confirm(`Abo „${sub.title || url}“ entfernen? Die ${n} Anbieter daraus werden freigegeben, deine eigenen Einträge bleiben.`)) return;
                            removeSub(url);
                            renderPanel();
                            showPanelNote(`Abo entfernt, ${n} Anbieter freigegeben.`, 'ok');
                        } }, 'Entfernen')));
        });
        const subCount = Object.keys(state.subs).length;
        const subTotal = Object.values(subCounts).reduce((a, b) => a + b, 0);

        const stamp = new Date().toISOString().slice(0, 10);
        const exportStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });

        const body = el('div', { className: 'kua-body' },
            el('div', { className: 'kua-note', role: 'status', hidden: !panel.note, dataset: panel.note && panel.note.kind ? { slot: 'note', kind: panel.note.kind } : { slot: 'note' } },
                panel.note ? panel.note.msg : ''),
            el('section', { className: 'kua-section' },
                el('h3', {}, `Blockierte Anbieter (${ids.length})`),
                el('div', { className: 'kua-row' }, addId, addName,
                    el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' }, onclick: doAdd }, 'Blockieren')),
                addStatus,
                ids.length > 5 ? filter : null,
                listBox,
                sourcesBox),
            el('section', { className: 'kua-section' },
                el('h3', {}, `Abonnierte Listen (${subCount})`),
                el('p', { className: 'kua-hint' }, 'Eine Liste unter einer festen Adresse abonnieren, z. B. eine Datei in einem GitHub-Repo. '
                    + 'Sie wird einmal täglich neu geladen: neue Anbieter kommen dazu, entfernte fallen weg. Gibst du einen Anbieter aus einem Abo frei, bleibt er freigegeben. '
                    + 'Beim Abruf sieht der Server der Liste deine IP-Adresse; es werden keine Daten mitgeschickt.'),
                el('div', { className: 'kua-row' }, subUrl,
                    el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' }, onclick: doSubscribe }, 'Abonnieren')),
                subStatus,
                subRows.length ? el('div', { className: 'kua-users' }, subRows) : null,
                subTotal ? el('p', { className: 'kua-hint' }, `Zusammen ${subTotal} Anbieter aus Abos. Sie stehen nicht in der Liste oben und werden nicht exportiert.`) : null),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Einzeln ausgeblendete Anzeigen'),
                el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }, `${hiddenAds} Anzeige${hiddenAds === 1 ? '' : 'n'}`),
                    el('button', { type: 'button', className: 'kua-action', disabled: !hiddenAds,
                        onclick: () => {
                            if (!window.confirm('Alle einzeln ausgeblendeten Anzeigen wieder einblenden?')) return;
                            state.ads = {}; saveAds(); refreshPage(); renderPanel();
                        } }, 'Alle wieder einblenden'))),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Darstellung'),
                modeRadio('collapse', 'Einklappen: eine Hinweiszeile bleibt stehen (mit „Kurz zeigen“ und „Freigeben“)'),
                modeRadio('hide', 'Ganz ausblenden: die Anzeige verschwindet aus der Liste'),
                el('h3', {}, 'Erkennung'),
                checkbox('dailyRefresh', 'Bestandslisten bzw. Shop-Seiten blockierter Anbieter einmal täglich neu einlesen, damit auch neue Anzeigen erkannt werden (empfohlen)'),
                checkbox('autoResolve', 'Unbekannte Anzeigen der Übersicht im Hintergrund prüfen (lädt dafür bis zu 30 Anzeigenseiten pro Seitenaufruf)')),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Liste hinzufügen (zusammenführen)'),
                el('p', { className: 'kua-hint' }, 'Eine fremde oder eigene Liste (JSON oder Textliste) prüfen und mit deiner Blockliste zusammenführen. Vor dem Übernehmen siehst du, welche Anbieter neu dazukommen.'),
                el('div', { className: 'kua-row' },
                    el('button', { type: 'button', className: 'kua-action', onclick: () => fileInput.click() }, 'Datei wählen …'),
                    fileInput),
                importText,
                el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }),
                    el('button', { type: 'button', className: 'kua-action', onclick: () => startPreview(importText.value, '') }, 'Eingefügte Liste prüfen')),
                ioStatus,
                previewBox),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Export'),
                el('div', { className: 'kua-row' },
                    el('button', { type: 'button', className: 'kua-action',
                        onclick: () => download(`kleinanzeigen-blockliste-${stamp}.json`, exportJson(), 'application/json') }, 'Als JSON speichern'),
                    el('button', { type: 'button', className: 'kua-action',
                        onclick: () => download(`kleinanzeigen-blockliste-${stamp}.txt`, exportText(), 'text/plain') }, 'Als Textliste speichern'),
                    el('button', { type: 'button', className: 'kua-action',
                        onclick: async () => setNote(exportStatus, await copyText(exportText()) ? 'Textliste in die Zwischenablage kopiert.' : 'Kopieren nicht möglich.') }, 'Kopieren')),
                exportStatus,
                el('p', { className: 'kua-hint' }, 'Gespeichert wird nur lokal in deinem Browser bzw. in deinem Userscript-Manager. Es werden keine Daten an fremde Server gesendet.')),
            el('p', { className: 'kua-hint' }, `Nutzer ausblenden ${VERSION} · `,
                el('a', { href: 'https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden', target: '_blank', rel: 'noopener' }, 'Projektseite')));

        box.replaceChildren(headBar('Blockliste', closePanel), body);
        box.scrollTop = scrollTop;
    }

    // Bleibt beim Neuzeichnen stehen (z. B. wenn danach Bestandslisten fertig geladen sind)
    function showPanelNote(msg, kind) {
        if (!panel) return;
        panel.note = { msg, kind };
        const slot = panel.box.querySelector('[data-slot="note"]');
        if (!slot) return;
        setNote(slot, msg, kind);
        panel.box.scrollTop = 0;
    }

    // ------------------------------------------------------------------
    // Änderungen aus anderen Tabs übernehmen
    // ------------------------------------------------------------------

    function onExternalChange() {
        const pending = pendingIndex;
        state = loadState();
        Object.assign(state.index, pending);
        refreshPage();
        if (panel) renderPanel();
    }

    function watchStorage() {
        const keys = [CONFIG.keys.users, CONFIG.keys.ads, CONFIG.keys.settings, CONFIG.keys.subs];
        if (hasGM && typeof GM_addValueChangeListener === 'function') {
            keys.forEach(k => GM_addValueChangeListener(k, (name, oldValue, newValue, remote) => { if (remote) onExternalChange(); }));
        } else if (!hasGM) {
            window.addEventListener('storage', e => { if (keys.includes(e.key)) onExternalChange(); });
        }
    }

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    injectStyles();
    watchStorage();
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Blockliste verwalten', () => openPanel());
    }

    if (isDetailPage) {
        runDetail();
    } else {
        runOverview();
    }
})();
