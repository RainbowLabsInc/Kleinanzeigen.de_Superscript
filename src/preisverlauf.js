/*
 * Modul: Preisverlauf & Gesehen
 * -----------------------------
 * Merkt sich lokal jede Anzeige, die in deinen Suchergebnissen auftaucht: Preis (nur bei
 * Änderungen, mit Datum), wann du sie zum ersten Mal gesehen und wann du sie geöffnet hast.
 * Es stellt dafür keine Anfragen an Kleinanzeigen, sondern liest nur, was ohnehin auf der
 * Seite steht.
 *
 * 1. Übersicht (Suchergebnisse, Bestandslisten, /s-..., und die Startseite): Unter dem Preis jeder Karte
 *    erscheinen kleine Markierungen:
 *      - „↓ vorher 120 €“ / „↑ vorher 95 €“, wenn sich der Preis seit dem letzten Sehen
 *        geändert hat (Klick: kompletter Verlauf mit Datum),
 *      - „Neu“ für Anzeigen, die bei deinem letzten Besuch derselben Suche noch nicht da waren
 *        (nicht auf der Startseite, sie ist keine Suche),
 *      - „Gesehen“ / „Geöffnet“ für Anzeigen, die du schon kennst. Diese lassen sich
 *        zusätzlich abdunkeln (außer, ihr Preis hat sich gerade geändert).
 * 2. Anzeigenseite (/s-anzeige/...): merkt sich das Öffnen und den Preis; unter dem Preis
 *    steht der bisherige Verlauf.
 *
 * „Gesehen“ heißt: Die Karte war mindestens zur Hälfte im sichtbaren Bereich. Ein Besuch einer
 * Suche endet nach 30 Minuten ohne Seitenaufruf in diesem Tab; Seite 2, 3 … zählen zur selben Suche.
 */

(function () {
    'use strict';

    const CONFIG = {
        keys: {
            ads: 'kps-ads',             // { <adId>: { f, l, o, p: [[Zeit, Preistext], ...] } }
            searches: 'kps-searches',   // { <Suche>: <Beginn des letzten Besuchs> }
            settings: 'kps-settings',
        },
        defaultSettings: {
            priceBadges: true,          // Preisänderungen an der Karte zeigen
            newBadges: true,            // „Neu“ seit dem letzten Besuch derselben Suche
            seenLabels: true,           // „Gesehen“ / „Geöffnet“
            dim: 'seen',                // 'seen' = gesehene + geöffnete, 'opened' = nur geöffnete, 'off'
        },
        // So viele Anzeigen merken; zuerst fallen die heraus, die am längsten nicht mehr auftauchten
        adsMax: 20000,
        searchesMax: 300,
        // Preisänderungen pro Anzeige
        historyMax: 12,
        // Besuch einer Suche endet nach so langer Pause (pro Tab)
        visitIdleMs: 30 * 60 * 1000,
        visitKeyPrefix: 'kps-visit:',
        // Anteil der Karte, der sichtbar sein muss, damit sie als gesehen gilt
        seenThreshold: 0.5,
        flushDelayMs: 1500,
        // Preis auf der Anzeigenseite (Stand 10/2026, Rückfall: reiner Preistext nahe der Überschrift)
        detailPriceSelectors: ['#viewad-price'],
        // Bedienelemente anderer Module, die beim Lesen des Preises ignoriert werden
        foreignUi: '.kps-ui, .klm-wrap, .klm-menu, .kua-ui',
    };

    const { el, load, save, isObj } = KS;

    const path = window.location.pathname;
    const isDetailPage = path.startsWith('/s-anzeige/');

    // ------------------------------------------------------------------
    // Helfer
    // ------------------------------------------------------------------

    const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const fmtDate = (ts) => new Date(ts).toLocaleDateString('de-DE');
    const fmtDay = (ts) => new Date(ts).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
    const fmtTime = (ts) => new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

    function getAdIdFromUrl(url) {
        // /s-anzeige/<slug>/<adId>-<kategorie>-<ort>
        const m = String(url || '').match(/\/s-anzeige\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    // Klicks in komplett verlinkten Karten dürfen nicht zur Anzeige navigieren
    function guard(node) {
        ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(t => node.addEventListener(t, e => e.stopPropagation()));
        node.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
        return node;
    }

    // ------------------------------------------------------------------
    // Preise lesen
    // ------------------------------------------------------------------

    // Preis-Bestandteile: "2 €", "3.399 €", "VB", "Zu verschenken", "ab"
    const pricePartsRe = /\d[\d.,]*\s*€|zu verschenken|VB|ab/gi;

    function isPriceOnly(text) {
        const t = text.trim();
        return t.length > 0 && /€|zu verschenken/i.test(t) && t.replace(pricePartsRe, '').replace(/\s+/g, '') === '';
    }

    // Text eines Elements ohne die Buttons anderer Module ("Melden", "Ausblenden")
    function textWithoutUi(node) {
        let text = node.textContent;
        node.querySelectorAll(CONFIG.foreignUi).forEach(ui => { text = text.split(ui.textContent).join(''); });
        return text;
    }

    // Durchgestrichener Altpreis, z. B. "3.399 €" neben "2 € VB"
    function isStruck(node, stop) {
        for (let n = node, i = 0; n && n !== stop && i < 5; n = n.parentElement, i++) {
            if (/^(S|DEL|STRIKE)$/.test(n.tagName)) return true;
            if ((getComputedStyle(n).textDecorationLine || '').includes('line-through')) return true;
        }
        return false;
    }

    // Element ohne eigene Kind-Elemente; Buttons anderer Module zählen nicht mit (die Blockliste
    // setzt ihren Button je nach Layout direkt in das Preis-Element)
    const isLeaf = (n) => Array.from(n.children).every(c => c.matches(CONFIG.foreignUi));

    // Reines Preis-Element (Text ohne fremde Buttons), nicht selbst Teil eines Buttons
    const isPriceLeaf = (n) => isLeaf(n) && !n.closest(CONFIG.foreignUi) && isPriceOnly(textWithoutUi(n));

    // Erstes reines Preis-Element in node (oder node selbst), ohne durchgestrichenen Altpreis
    function currentPriceEl(node) {
        return [node, ...node.querySelectorAll('*')].find(n => isPriceLeaf(n) && !isStruck(n, node.parentElement)) || null;
    }

    // Preiszeile einer Karte; gleiche Logik wie in "Anzeige melden", damit alle Module dieselbe Zeile finden
    function findPriceRow(card) {
        const classic = card.querySelector('.aditem-main--middle--price-shipping');
        if (classic) return classic;
        const first = Array.from(card.querySelectorAll('p, span, div, strong, b')).find(isPriceLeaf);
        if (!first) return null;
        let row = first;
        while (row.parentElement && row.parentElement !== card && isPriceOnly(textWithoutUi(row.parentElement))) {
            row = row.parentElement;
        }
        return row;
    }

    // "1.234,50 € VB" -> { cents: 123450, vb: true }; "Zu verschenken" -> { cents: 0 }; "VB" -> { cents: null }
    function parsePrice(text) {
        const t = String(text || '');
        const vb = /\bVB\b/.test(t);
        if (/zu verschenken/i.test(t)) return { cents: 0, vb };
        const m = t.match(/(\d[\d.]*)(?:,(\d{1,2}))?\s*€/);
        if (!m) return { cents: null, vb };
        const euros = Number(m[1].replace(/\./g, ''));
        const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
        return { cents: Number.isFinite(euros) ? euros * 100 + cents : null, vb };
    }

    // Zwei Preistexte gelten als gleich, wenn Betrag und VB übereinstimmen (Schreibweise egal)
    const priceKey = (text) => { const p = parsePrice(text); return `${p.cents}|${p.vb ? 1 : 0}`; };

    // ------------------------------------------------------------------
    // Speicher
    // ------------------------------------------------------------------

    function cleanEntry(raw) {
        if (!isObj(raw)) return null;
        const e = { p: [] };
        if (num(raw.f)) e.f = raw.f;
        if (num(raw.l)) e.l = raw.l;
        if (num(raw.o)) e.o = raw.o;
        if (Array.isArray(raw.p)) {
            e.p = raw.p.filter(x => Array.isArray(x) && num(x[0]) && typeof x[1] === 'string')
                .map(x => [x[0], clip(x[1], 40)]);
        }
        return e;
    }

    function loadAds() {
        const out = {};
        const raw = load(CONFIG.keys.ads, {});
        if (isObj(raw)) {
            for (const [id, v] of Object.entries(raw)) {
                const e = /^\d{1,15}$/.test(id) && cleanEntry(v);
                if (e) out[id] = e;
            }
        }
        return out;
    }

    function loadSettings() {
        const s = { ...CONFIG.defaultSettings };
        const raw = load(CONFIG.keys.settings, {});
        if (isObj(raw)) {
            ['priceBadges', 'newBadges', 'seenLabels'].forEach(k => { if (typeof raw[k] === 'boolean') s[k] = raw[k]; });
            if (['seen', 'opened', 'off'].includes(raw.dim)) s.dim = raw.dim;
        }
        return s;
    }

    let ads = loadAds();
    let settings = loadSettings();
    const dirty = new Set(); // geänderte Anzeigen, noch nicht gespeichert

    // Preisverlauf: sortiert, aufeinanderfolgende gleiche Preise zusammengefasst, gekürzt
    function tidyHistory(list) {
        const out = [];
        list.slice().sort((a, b) => a[0] - b[0]).forEach(x => {
            const last = out[out.length - 1];
            if (!last || priceKey(last[1]) !== priceKey(x[1])) out.push(x);
        });
        return out.slice(-CONFIG.historyMax);
    }

    function mergeEntry(a, b) {
        if (!a) return b;
        if (!b) return a;
        const min = (x, y) => (x && y ? Math.min(x, y) : x || y);
        const max = (x, y) => Math.max(x || 0, y || 0) || undefined;
        return cleanEntry({ f: min(a.f, b.f), l: max(a.l, b.l), o: max(a.o, b.o), p: tidyHistory([...a.p, ...b.p]) });
    }

    // Vor dem Speichern mit dem gespeicherten Stand zusammenführen, damit parallel offene Tabs
    // nichts überschreiben
    function mergeWithStored() {
        const stored = loadAds();
        dirty.forEach(id => { stored[id] = mergeEntry(stored[id], ads[id]); });
        return stored;
    }

    function prune(map, max, age) {
        const keys = Object.keys(map);
        if (keys.length <= max) return;
        keys.sort((a, b) => age(map[a]) - age(map[b]))
            .slice(0, keys.length - max)
            .forEach(k => { delete map[k]; });
    }

    let flushTimer = null;

    function flush() {
        clearTimeout(flushTimer);
        flushTimer = null;
        if (!dirty.size) return;
        const merged = mergeWithStored();
        prune(merged, CONFIG.adsMax, e => e.l || e.o || e.f || 0);
        dirty.clear();
        ads = merged;
        save(CONFIG.keys.ads, merged);
    }

    function scheduleFlush() {
        if (dirty.size && !flushTimer) flushTimer = setTimeout(flush, CONFIG.flushDelayMs);
    }

    const entry = (adId) => ads[adId] || (ads[adId] = { p: [] });

    // Preis beobachten: nur Änderungen landen im Verlauf
    function observe(adId, priceText) {
        const e = entry(adId);
        e.l = Date.now();
        const text = clip(priceText, 40);
        const last = e.p[e.p.length - 1];
        if (text && (!last || priceKey(last[1]) !== priceKey(text))) {
            e.p.push([Date.now(), text]);
            e.p = e.p.slice(-CONFIG.historyMax);
        }
        dirty.add(adId);
        scheduleFlush();
    }

    function markSeen(adId) {
        const e = entry(adId);
        if (e.f) return;
        e.f = Date.now();
        dirty.add(adId);
        scheduleFlush();
    }

    function clearHistory() {
        ads = {};
        dirty.clear();
        save(CONFIG.keys.ads, {});
        save(CONFIG.keys.searches, {});
        try {
            Object.keys(sessionStorage).filter(k => k.startsWith(CONFIG.visitKeyPrefix)).forEach(k => sessionStorage.removeItem(k));
        } catch (e) { /* egal */ }
        visit = null;
    }

    // ------------------------------------------------------------------
    // Besuch einer Suche
    // ------------------------------------------------------------------

    let visit = null; // { start, prev, touched }

    // Beginn dieses Besuchs und des vorherigen (pro Tab im sessionStorage, damit Seite 2 und
    // Neuladen zum selben Besuch zählen)
    function beginVisit() {
        const now = Date.now();
        // Die Startseite ist keine Suche: dort kein „Neu“, nur „Gesehen“ und Preise
        if (!path.startsWith('/s-')) return { start: now, prev: 0, touched: now };
        const key = KS.searchKey(window.location.href);
        const sk = CONFIG.visitKeyPrefix + key;
        let v = null;
        try { v = JSON.parse(sessionStorage.getItem(sk) || 'null'); } catch (e) { v = null; }
        if (!isObj(v) || !num(v.start) || now - num(v.touched) > CONFIG.visitIdleMs) {
            const raw = load(CONFIG.keys.searches, {});
            const searches = isObj(raw) ? raw : {};
            v = { start: now, prev: num(searches[key]) };
            searches[key] = now;
            prune(searches, CONFIG.searchesMax, ts => num(ts));
            save(CONFIG.keys.searches, searches);
        }
        v.touched = now;
        try { sessionStorage.setItem(sk, JSON.stringify(v)); } catch (e) { /* gilt nur für diesen Seitenaufruf */ }
        return v;
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        [data-kps-dim] { opacity: .5; transition: opacity .15s; }
        [data-kps-dim]:hover, [data-kps-dim]:focus-within { opacity: 1; }
        .kps-badges { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; font-size: 12px; line-height: 18px; }
        .kps-badge {
            display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: 999px;
            border: 1px solid #d0d0cc; background: #fff; color: #555;
            font: inherit; font-size: 12px; font-weight: 600; line-height: 18px; white-space: nowrap;
        }
        button.kps-badge { cursor: pointer; }
        button.kps-badge:hover, button.kps-badge:focus-visible { border-color: #1e1e1e; outline: none; }
        .kps-badge[data-kind="down"] { border-color: #a5d6a7; background: #edf7ee; color: #1f5e23; }
        .kps-badge[data-kind="up"] { border-color: #f3c58f; background: #fff4e5; color: #8a4b00; }
        .kps-badge[data-kind="new"] { border-color: #1e88e5; background: #1e88e5; color: #fff; }
        .kps-badge[data-kind="seen"], .kps-badge[data-kind="opened"] { border-style: dashed; }

        .kps-pop {
            position: absolute; z-index: 2147482000; box-sizing: border-box; max-height: calc(100vh - 32px); overflow: auto;
            background: #fff; color: #1e1e1e; border: 1px solid #d0d0cc; border-radius: 12px;
            box-shadow: 0 12px 32px rgba(0,0,0,.22); font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
        }
        .kps-pop *, .kps-pop *::before, .kps-pop *::after { box-sizing: border-box; }
        .kps-pop-head {
            position: sticky; top: 0; display: flex; align-items: center; gap: 8px;
            padding: 8px 8px 8px 14px; background: #fff; border-bottom: 1px solid #eceae6;
        }
        .kps-pop-title { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .kps-pop-body { padding: 10px 14px 12px; display: grid; gap: 8px; }
        .kps-pop button { font: inherit; color: inherit; }
        .kps-icon-btn {
            flex: none; width: 30px; height: 30px; display: inline-grid; place-items: center;
            border: 0; border-radius: 8px; background: transparent; cursor: pointer; font-size: 18px; line-height: 1;
        }
        .kps-icon-btn:hover, .kps-icon-btn:focus-visible { background: #f2f1ee; outline: none; }
        .kps-history { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; font-size: 13px; }
        .kps-history li { display: flex; gap: 12px; justify-content: space-between; padding: 3px 0; border-bottom: 1px dotted #e3e1dc; }
        .kps-history li:last-child { border-bottom: 0; font-weight: 700; }
        .kps-history time { color: #6b6b6b; font-variant-numeric: tabular-nums; }
        .kps-muted { margin: 0; font-size: 12px; color: #6b6b6b; }
        .kps-link { justify-self: start; padding: 0; border: 0; background: none; color: #555; text-decoration: underline; font-size: 13px; cursor: pointer; }
        .kps-link:hover { color: #1e1e1e; }

        .kps-detail {
            display: grid; gap: 2px; margin: 6px 0 10px; padding: 8px 12px;
            border: 1px dashed #c9c7c2; border-radius: 8px; background: #f7f6f3; color: #555;
            font-size: 13px; line-height: 1.4; font-weight: 400;
        }
        .kps-detail strong { color: #1e1e1e; }
    `;
    const ensureStyles = () => { if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl); };

    // Ruft fn gebündelt (einmal pro Frame) auf, sobald sich das Dokument ändert
    function watchPage(fn) {
        let scheduled = false;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; fn(); });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // ------------------------------------------------------------------
    // Verlauf als Popover
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
        const width = Math.min(320, vw - 32);
        root.style.width = width + 'px';
        const left = Math.min(Math.max(16, r.left), vw - 16 - width);
        const h = root.offsetHeight;
        const below = r.bottom + 6;
        const top = (below + h > vh - 8 && r.top - 6 - h > 8) ? r.top - 6 - h : below;
        root.style.left = (left + window.scrollX) + 'px';
        root.style.top = (top + window.scrollY) + 'px';
    }

    function historyList(e) {
        return el('ol', { className: 'kps-history' },
            e.p.map(([ts, text]) => el('li', {}, el('time', { dateTime: new Date(ts).toISOString(), title: fmtTime(ts) }, fmtDate(ts)), el('span', {}, text))));
    }

    function sightingText(e) {
        return [
            e.f ? `Zuerst gesehen am ${fmtDate(e.f)}` : '',
            e.o ? `zuletzt geöffnet am ${fmtDate(e.o)}` : '',
        ].filter(Boolean).join(', ');
    }

    function openPopover(adId, title, btn) {
        if (pop && pop.btn === btn) { closePopover(); return; }
        closePopover();
        const e = ads[adId];
        if (!e) return;
        const root = el('div', { className: 'kps-ui kps-pop', role: 'dialog', 'aria-label': 'Preisverlauf' });
        const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closePopover(); } };
        const onOutside = (ev) => { if (pop && !root.contains(ev.target) && !btn.contains(ev.target)) closePopover(); };
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
        const seen = sightingText(e);
        root.append(
            el('div', { className: 'kps-pop-head' },
                el('span', { className: 'kps-pop-title', title: title || '' }, title ? `Preisverlauf: ${title}` : 'Preisverlauf'),
                el('button', { type: 'button', className: 'kps-icon-btn', 'aria-label': 'Schließen', title: 'Schließen', onclick: closePopover }, '×')),
            el('div', { className: 'kps-pop-body' },
                historyList(e),
                el('p', { className: 'kps-muted' }, 'Erfasst, wenn die Anzeige in deinen Suchergebnissen stand oder du sie geöffnet hast. '
                    + 'Änderungen dazwischen sind nicht bekannt.'),
                seen ? el('p', { className: 'kps-muted' }, seen + '.') : null,
                el('button', { type: 'button', className: 'kps-link', onclick: () => { closePopover(); KS.openSettings(); } }, 'Einstellungen …')));
        document.body.appendChild(root);
        positionPopover();
        root.querySelector('.kps-icon-btn').focus({ preventScroll: true });
    }

    // ------------------------------------------------------------------
    // Übersicht
    // ------------------------------------------------------------------

    function findAdCards() {
        const cards = new Set();
        document.querySelectorAll('article.aditem[data-adid]').forEach(c => cards.add(c));
        // Generisch: vom Anzeigen-Link so weit nach oben laufen, wie der Container
        // nur Links auf genau diese eine Anzeige enthält -> das ist die Karte.
        document.querySelectorAll('a[href*="/s-anzeige/"]').forEach(link => {
            if (link.closest(`${CONFIG.foreignUi}, article.aditem[data-adid]`)) return;
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
        const cached = cardInfos.get(card);
        // Die Seite baut Karten teils neu auf: dann Preiszeile neu suchen
        if (cached && (!cached.row || (cached.row.isConnected && card.contains(cached.row)))) return cached;
        const link = card.querySelector('a[href*="/s-anzeige/"]');
        const adId = card.dataset.adid || getAdIdFromUrl(card.dataset.href || (link ? link.getAttribute('href') : ''));
        if (!adId || !/^\d{1,15}$/.test(adId)) return null;
        const row = findPriceRow(card);
        const priceEl = row ? currentPriceEl(row) : null;
        const titleEl = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        const info = {
            adId, row,
            price: priceEl ? clip(textWithoutUi(priceEl), 40) : '',
            title: clip(titleEl ? titleEl.textContent : (link ? link.textContent : ''), 120),
        };
        cardInfos.set(card, info);
        return info;
    }

    // Was an einer Karte angezeigt wird
    function viewState(e) {
        const v = { change: null, isNew: false, seen: null, dim: false };
        if (settings.priceBadges && e && e.p.length > 1) {
            const prev = e.p[e.p.length - 2];
            const cur = e.p[e.p.length - 1];
            const a = parsePrice(prev[1]).cents;
            const b = parsePrice(cur[1]).cents;
            v.change = { dir: a != null && b != null && a !== b ? (b < a ? 'down' : 'up') : 'changed', prev: prev[1], since: cur[0] };
        }
        const seenBefore = !!(e && e.f && e.f < visit.start);
        const opened = !!(e && e.o);
        v.isNew = settings.newBadges && !!visit.prev && !seenBefore && !opened;
        if (settings.seenLabels) v.seen = opened ? 'opened' : seenBefore ? 'seen' : null;
        v.dim = settings.dim === 'seen' ? (seenBefore || opened) : settings.dim === 'opened' ? opened : false;
        // Gerade geänderter Preis: nicht abdunkeln, die Anzeige ist wieder interessant
        if (v.change && v.change.since >= visit.start) v.dim = false;
        return v;
    }

    function badges(info, v, e) {
        const out = [];
        if (v.change) {
            const label = v.change.dir === 'down' ? `↓ vorher ${v.change.prev}`
                : v.change.dir === 'up' ? `↑ vorher ${v.change.prev}` : 'Preis geändert';
            const word = v.change.dir === 'down' ? 'gesenkt' : v.change.dir === 'up' ? 'erhöht' : 'geändert';
            const btn = guard(el('button', { type: 'button', className: 'kps-badge', dataset: { kind: v.change.dir },
                title: `Preis am ${fmtDate(v.change.since)} ${word} (vorher ${v.change.prev}). Klicken für den ganzen Verlauf.` }, label));
            btn.addEventListener('click', () => openPopover(info.adId, info.title, btn));
            out.push(btn);
        }
        if (v.isNew) {
            out.push(el('span', { className: 'kps-badge', dataset: { kind: 'new' },
                title: 'Bei deinem letzten Besuch dieser Suche war die Anzeige noch nicht zu sehen' }, 'Neu'));
        }
        if (v.seen === 'opened') {
            out.push(el('span', { className: 'kps-badge', dataset: { kind: 'opened' }, title: `${sightingText(e)}.` }, `Geöffnet ${fmtDay(e.o)}`));
        } else if (v.seen === 'seen') {
            out.push(el('span', { className: 'kps-badge', dataset: { kind: 'seen' }, title: `${sightingText(e)}.` }, `Gesehen ${fmtDay(e.f)}`));
        }
        return out;
    }

    const observed = new Set();    // in diesem Seitenaufruf schon erfasste Anzeigen
    const watched = new WeakSet(); // Karten, die der IntersectionObserver beobachtet

    const seenObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
        entries.forEach(en => {
            if (!en.isIntersecting) return;
            const card = en.target;
            // Eingeklappte Anzeigen blockierter Anbieter zählen nicht als gesehen
            if (card.dataset.kuaState === 'collapsed' || card.closest('[data-kua-hidden]')) return;
            seenObserver.unobserve(card);
            if (card.dataset.kpsAdid) markSeen(card.dataset.kpsAdid);
        });
    }, { threshold: CONFIG.seenThreshold }) : null;

    function applyCard(card) {
        const info = getCardInfo(card);
        if (!info) return;
        if (!observed.has(info.adId)) {
            observed.add(info.adId);
            observe(info.adId, info.price);
        }
        if (!watched.has(card)) {
            watched.add(card);
            card.dataset.kpsAdid = info.adId;
            if (seenObserver) seenObserver.observe(card);
            else markSeen(info.adId);
        }

        const e = ads[info.adId];
        const v = viewState(e);
        const sig = JSON.stringify([v, e && e.f, e && e.o]);
        const box = card.querySelector('.kps-badges');
        const needed = !!(v.change || v.isNew || v.seen);
        // Neu zeichnen, wenn sich der Zustand geändert hat oder die Seite unsere Änderungen entfernt hat
        if (card.dataset.kpsSig === sig && !!box === needed && card.hasAttribute('data-kps-dim') === v.dim) return;
        card.dataset.kpsSig = sig;
        if (v.dim) card.setAttribute('data-kps-dim', ''); else card.removeAttribute('data-kps-dim');
        if (!needed) {
            if (box) box.remove();
            return;
        }
        const target = box || el('div', { className: 'kps-ui kps-badges' });
        target.replaceChildren(...badges(info, v, e));
        if (!box) {
            if (info.row && card.contains(info.row)) info.row.insertAdjacentElement('afterend', target);
            else card.appendChild(target);
        }
    }

    function applyOverview() {
        ensureStyles();
        if (pop && !pop.btn.isConnected) closePopover();
        const cards = findAdCards();
        if (!cards.length) return;
        if (!visit) visit = beginVisit();
        cards.forEach(applyCard);
    }

    // Zustand neu laden (anderer Tab, Zurück-Taste aus dem Cache) und neu zeichnen.
    // Nur bei der Rückkehr per Zurück-Taste zählt das als neuer Seitenaufruf der Suche.
    function reloadState(returned) {
        ads = mergeWithStored();
        settings = loadSettings();
        if (isDetailPage) return;
        if (visit && returned === true) visit = beginVisit();
        document.querySelectorAll('[data-kps-sig]').forEach(c => { delete c.dataset.kpsSig; });
        applyOverview();
    }

    function runOverview() {
        applyOverview();
        watchPage(applyOverview);
    }

    // ------------------------------------------------------------------
    // Anzeigenseite
    // ------------------------------------------------------------------

    function findDetailPrice() {
        for (const sel of CONFIG.detailPriceSelectors) {
            const node = document.querySelector(sel);
            const hit = node && currentPriceEl(node);
            if (hit) return hit;
        }
        // Rückfall: reiner Preistext in der Nähe der Überschrift, nicht in verlinkten Empfehlungen
        const h1 = document.querySelector('#viewad-title, h1');
        let scope = h1 && h1.parentElement;
        for (let i = 0; scope && i < 4; i++, scope = scope.parentElement) {
            const hit = Array.from(scope.querySelectorAll('h2, h3, p, span, div, strong, b')).find(n => isPriceLeaf(n)
                && !n.closest('a[href*="/s-anzeige/"]') && !isStruck(n, scope));
            if (hit) return hit;
        }
        return null;
    }

    function runDetail() {
        const adId = getAdIdFromUrl(window.location.href);
        if (!adId) return;
        const before = ads[adId] ? { ...ads[adId] } : null;
        const e = entry(adId);
        const now = Date.now();
        if (!e.f) e.f = now;
        e.o = now;
        dirty.add(adId);
        flush();

        let box = null;
        let priceEl = null;
        let reinserts = 0;

        const render = () => {
            const cur = ads[adId];
            if (!cur) return null;
            const lines = [];
            if (cur.p.length > 1) {
                lines.push(el('span', {}, el('strong', {}, 'Preisverlauf: '),
                    cur.p.map(([ts, text], i) => `${i ? ' → ' : ''}${text} (${fmtDay(ts)})`).join('')));
            }
            // Erstes Auftauchen: gesehen, sonst erster erfasster Preis (Karte stand in der Liste)
            const first = before && (before.f || (before.p[0] && before.p[0][0]));
            if (first) lines.push(el('span', {}, `Zuerst gesehen am ${fmtDate(first)}`
                + (before.o ? `, zuletzt geöffnet am ${fmtDate(before.o)}` : '') + '.'));
            if (!lines.length) return null;
            return el('div', { className: 'kps-ui kps-detail' }, lines);
        };

        // Der Preis kann nachgerendert werden, und die Seite baut Teile neu auf: dann wieder einsetzen
        const ensure = () => {
            ensureStyles();
            if (!priceEl || !priceEl.isConnected) {
                const found = findDetailPrice();
                if (!found) return;
                const first = !priceEl;
                priceEl = found;
                if (first) {
                    observe(adId, clip(textWithoutUi(priceEl), 40));
                    flush();
                    box = render();
                }
            }
            if (box && !box.isConnected && reinserts < 20) {
                priceEl.insertAdjacentElement('afterend', box);
                reinserts++;
            }
        };
        ensure();
        watchPage(ensure);
    }

    // ------------------------------------------------------------------
    // Einstellungen (im Superscript-Dialog)
    // ------------------------------------------------------------------

    function setSetting(key, value) {
        settings[key] = value;
        save(CONFIG.keys.settings, settings);
        if (!isDetailPage) {
            document.querySelectorAll('[data-kps-sig]').forEach(c => { delete c.dataset.kpsSig; });
            applyOverview();
        }
    }

    KS.addSettings('preisverlauf', () => {
        const all = Object.values(loadAds());
        const changed = all.filter(e => e.p.length > 1).length;
        const status = el('span', { className: 'ks-spacer ks-muted' },
            `${all.length} Anzeige${all.length === 1 ? '' : 'n'} im Verlauf, davon ${changed} mit Preisänderung.`);
        return [
            el('h3', {}, 'Preisverlauf & Gesehen'),
            KS.checkbox('Preisänderungen an der Anzeige zeigen („↓ vorher 120 €“)', settings.priceBadges, v => setSetting('priceBadges', v)),
            KS.checkbox('„Neu“ markieren: Anzeigen, die beim letzten Besuch derselben Suche noch nicht da waren', settings.newBadges, v => setSetting('newBadges', v)),
            KS.checkbox('„Gesehen“ und „Geöffnet“ markieren', settings.seenLabels, v => setSetting('seenLabels', v)),
            el('p', { className: 'ks-hint' }, 'Abdunkeln (beim Darüberfahren wieder normal):'),
            KS.radio('kps-dim', 'Gesehene und geöffnete Anzeigen abdunkeln', settings.dim === 'seen', () => setSetting('dim', 'seen')),
            KS.radio('kps-dim', 'Nur geöffnete Anzeigen abdunkeln', settings.dim === 'opened', () => setSetting('dim', 'opened')),
            KS.radio('kps-dim', 'Nichts abdunkeln', settings.dim === 'off', () => setSetting('dim', 'off')),
            el('div', { className: 'ks-row' }, status,
                el('button', { type: 'button', className: 'ks-action', dataset: { danger: '' }, disabled: !all.length,
                    onclick: (ev) => {
                        if (!window.confirm('Den gesamten Preisverlauf und alle „Gesehen“-Markierungen löschen?')) return;
                        clearHistory();
                        if (!isDetailPage) {
                            document.querySelectorAll('[data-kps-sig]').forEach(c => { delete c.dataset.kpsSig; });
                            applyOverview();
                        }
                        status.textContent = 'Verlauf gelöscht.';
                        ev.target.disabled = true;
                    } }, 'Verlauf löschen')),
            el('p', { className: 'ks-hint' }, `Es werden höchstens ${CONFIG.adsMax.toLocaleString('de-DE')} Anzeigen gemerkt; `
                + 'die am längsten nicht mehr gesehenen fallen zuerst heraus. Kleinanzeigen bekommt davon nichts mit.'),
        ];
    });

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    KS.onRemoteChange(CONFIG.keys.ads, () => reloadState(false));
    KS.onRemoteChange(CONFIG.keys.settings, () => reloadState(false));
    // Speichern, bevor der Tab geschlossen oder eine Anzeige geöffnet wird
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    // Zurück-Taste: Seite kommt aus dem Cache, ohne dass das Script neu startet
    window.addEventListener('pageshow', (ev) => { if (ev.persisted) reloadState(true); });

    if (isDetailPage) runDetail();
    else runOverview();
})();
