/*
 * Modul: Gespeicherte Suchen
 * --------------------------
 * Sidebar am rechten Rand mit eigenen, benannten Suchen. Ein Klick öffnet die Suche, die
 * Liste bleibt dabei offen; so springt man schnell zwischen „Verschenken“, „Auto“ usw. hin
 * und her. Gespeichert wird die Adresse der Ergebnisseite ohne Seitenzahl, also mit allen
 * Filtern, die Kleinanzeigen in der Adresse führt.
 *
 * - „Aktuelle Suche speichern“ mit Namensvorschlag, umbenennen, sortieren, löschen
 * - die gerade offene Suche ist hervorgehoben, dazu „besucht vor …“
 * - Tastenkürzel Alt+1 … Alt+9 für die ersten neun Suchen (abschaltbar)
 * - optional „3 neu“: lädt die erste Ergebnisseite gespeicherter Suchen im Hintergrund
 *   (standardmäßig aus, höchstens einmal pro Stunde und Suche, pro Seitenaufruf höchstens 5)
 *   und zählt Anzeigen, die beim letzten Besuch der Suche noch nicht da waren. Schon
 *   gesehene (Modul Preisverlauf) und ausgeblendete Anzeigen (Modul Nutzer ausblenden)
 *   zählen nicht mit.
 */

(function () {
    'use strict';

    const CONFIG = {
        keys: {
            searches: 'kss-searches',   // [{ id, name, url, added, visited, known: [adId], count, total, checked, error }]
            settings: 'kss-settings',
        },
        defaultSettings: {
            open: false,                // Sidebar aufgeklappt (bleibt beim Seitenwechsel so)
            newCounts: false,           // „3 neu“ im Hintergrund zählen
            shortcuts: true,            // Alt+1 … Alt+9
        },
        max: 50,
        nameMax: 60,
        // So viele Anzeigen einer Suche merken (für „neu seit dem letzten Besuch“)
        knownMax: 300,
        // Hintergrund-Zählung: Abstand pro Suche, höchstens so viele pro Seitenaufruf, Pause, Start
        checkEveryMs: 60 * 60 * 1000,
        checksPerVisit: 5,
        requestGapMs: 1500,
        checkDelayMs: 4000,
        // Ergebnisliste (Rückfall: größte Liste mit Anzeigen-Links), Stand 10/2026
        resultListSelectors: ['#srchrslt-adtable'],
        // Suchfeld der Seite für den Namensvorschlag (Rückfall: Seitentitel, dann Adresse)
        searchInputs: ['#site-search-query', 'input[name="keywords"]', 'header input[type="search"]', 'header input[type="text"]'],
        // Daten anderer Module (gleicher Speicher): gesehene, blockierte, ausgeblendete Anzeigen
        foreign: { ads: 'kps-ads', users: 'kua-users', hiddenAds: 'kua-hidden-ads', index: 'kua-ad-index' },
    };

    const { el, load, save, isObj } = KS;

    const path = window.location.pathname;
    const isDetailPage = path.startsWith('/s-anzeige/');
    // Nur Such- und Listenseiten (/s-…) sind speicherbare Suchen, nicht die Startseite
    const currentKey = path.startsWith('/s-') && !isDetailPage ? KS.searchKey(window.location.href) : null;

    // ------------------------------------------------------------------
    // Helfer
    // ------------------------------------------------------------------

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const newId = () => Math.random().toString(36).slice(2, 10);

    function relTime(ts) {
        const min = Math.round((Date.now() - ts) / 60000);
        if (min < 1) return 'gerade eben';
        if (min < 60) return `vor ${min} Min.`;
        const h = Math.round(min / 60);
        if (h < 24) return `vor ${h} Std.`;
        const d = Math.round(h / 24);
        return d === 1 ? 'gestern' : `vor ${d} Tagen`;
    }

    function getAdIdFromUrl(url) {
        // /s-anzeige/<slug>/<adId>-<kategorie>-<ort>
        const m = String(url || '').match(/\/s-anzeige\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    // Nur Such- und Listenseiten von kleinanzeigen.de, gespeichert ohne Seitenzahl
    function normalizeSearchUrl(raw) {
        let url;
        try { url = new URL(String(raw || ''), window.location.origin); } catch (e) { return null; }
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/s-') || url.pathname.startsWith('/s-anzeige/')) return null;
        const key = KS.searchKey(url.href);
        return key.length <= 1000 ? key : null;
    }

    // Anzeigen-Nummern der Ergebnisliste. Bewusst nur die größte Liste, damit Empfehlungen
    // am Rand nicht mitzählen (gleiche Logik wie in "Nutzer ausblenden").
    function mainListAdIds(doc) {
        let scope = null;
        for (const sel of CONFIG.resultListSelectors) {
            scope = doc.querySelector(sel);
            if (scope) break;
        }
        const groups = new Map();
        (scope || doc).querySelectorAll('article[data-adid], a[href*="/s-anzeige/"]').forEach(node => {
            if (node.closest('.kss-ui, .kps-ui, .kua-ui')) return;
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

    // Namensvorschlag: Suchbegriff aus dem Suchfeld, sonst Seitentitel, sonst Adresse
    function suggestName() {
        for (const sel of CONFIG.searchInputs) {
            const input = document.querySelector(sel);
            if (input && clip(input.value, CONFIG.nameMax)) return clip(input.value, CONFIG.nameMax);
        }
        const title = clip(document.title.split(/\s+[|–-]\s+/)[0], CONFIG.nameMax);
        if (title) return title;
        const seg = path.split('/').filter(s => s && !/^s-$|^k0|^c\d|^seite:/.test(s)).pop() || '';
        let word = seg.replace(/^s-/, '');
        try { word = decodeURIComponent(word); } catch (e) { /* Adresse unverändert lassen */ }
        return clip(word.replace(/[-+]/g, ' '), CONFIG.nameMax) || 'Meine Suche';
    }

    // ------------------------------------------------------------------
    // Speicher
    // ------------------------------------------------------------------

    function cleanSearch(o) {
        if (!isObj(o)) return null;
        const url = normalizeSearchUrl(o.url);
        if (!url) return null;
        return {
            id: typeof o.id === 'string' && /^[a-z0-9]{1,16}$/.test(o.id) ? o.id : newId(),
            name: clip(o.name, CONFIG.nameMax) || 'Suche',
            url,
            added: num(o.added) || Date.now(),
            visited: num(o.visited),
            known: Array.isArray(o.known) ? o.known.filter(x => typeof x === 'string' && /^\d{1,15}$/.test(x)).slice(-CONFIG.knownMax) : [],
            count: num(o.count),
            total: num(o.total),
            checked: num(o.checked),
            error: clip(o.error, 120),
        };
    }

    function loadSearches() {
        const raw = load(CONFIG.keys.searches, []);
        return Array.isArray(raw) ? raw.map(cleanSearch).filter(Boolean).slice(0, CONFIG.max) : [];
    }

    function loadSettings() {
        const s = { ...CONFIG.defaultSettings };
        const raw = load(CONFIG.keys.settings, {});
        if (isObj(raw)) Object.keys(s).forEach(k => { if (typeof raw[k] === 'boolean') s[k] = raw[k]; });
        return s;
    }

    let searches = loadSearches();
    let settings = loadSettings();

    // Ändern immer auf dem frisch geladenen Stand, damit parallel offene Tabs nichts überschreiben
    function mutate(fn) {
        searches = loadSearches();
        fn(searches);
        save(CONFIG.keys.searches, searches);
        render();
    }

    function updateSearch(id, fn) {
        mutate(list => { const s = list.find(x => x.id === id); if (s) fn(s); });
    }

    function setSetting(key, value) {
        settings = { ...loadSettings(), [key]: value };
        save(CONFIG.keys.settings, settings);
        render();
    }

    const currentSearch = () => (currentKey ? searches.find(s => s.url === currentKey) : null);

    // ------------------------------------------------------------------
    // Besuch einer gespeicherten Suche: Anzeigen merken, Zähler zurücksetzen
    // ------------------------------------------------------------------

    function noteVisit() {
        const s = currentSearch();
        if (!s) return;
        const ids = mainListAdIds(document);
        const known = new Set(s.known);
        const fresh = ids.filter(id => !known.has(id));
        const stale = Date.now() - s.visited > 60 * 1000;
        if (!fresh.length && !stale && !s.count) return;
        updateSearch(s.id, x => {
            x.visited = Date.now();
            x.count = 0;
            x.known = [...x.known.filter(id => !fresh.includes(id)), ...fresh].slice(-CONFIG.knownMax);
        });
    }

    // ------------------------------------------------------------------
    // Hintergrund-Zählung „3 neu“
    // ------------------------------------------------------------------

    async function fetchDoc(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
    }

    // Neu = beim letzten Besuch der Suche nicht in der Liste, nicht schon woanders gesehen,
    // nicht ausgeblendet und nicht von einem blockierten Anbieter
    function countNew(s, ids) {
        const known = new Set(s.known);
        const seen = load(CONFIG.foreign.ads, {});
        const users = load(CONFIG.foreign.users, {});
        const hidden = load(CONFIG.foreign.hiddenAds, {});
        const index = load(CONFIG.foreign.index, {});
        const ok = (m) => (isObj(m) ? m : {});
        const [seenM, usersM, hiddenM, indexM] = [ok(seen), ok(users), ok(hidden), ok(index)];
        return ids.filter(id => !known.has(id)
            && !(isObj(seenM[id]) && (seenM[id].f || seenM[id].o))
            && !hiddenM[id]
            && !(indexM[id] && usersM[String(indexM[id]).toLowerCase()])).length;
    }

    let checking = false;

    async function checkSearches(force) {
        if (checking || !settings.newCounts) return;
        checking = true;
        try {
            const due = loadSearches()
                .filter(s => s.url !== currentKey && (force || Date.now() - s.checked > CONFIG.checkEveryMs))
                .sort((a, b) => a.checked - b.checked)
                .slice(0, force ? CONFIG.max : CONFIG.checksPerVisit);
            for (const s of due) {
                if (!settings.newCounts) break;
                // Prüfung anmelden, damit andere Tabs dieselbe Suche nicht gleichzeitig laden
                let claimed = false;
                updateSearch(s.id, x => {
                    if (force || Date.now() - x.checked > CONFIG.checkEveryMs) { x.checked = Date.now(); claimed = true; }
                });
                if (!claimed) continue;
                try {
                    const ids = mainListAdIds(await fetchDoc(s.url));
                    updateSearch(s.id, x => { x.count = countNew(x, ids); x.total = ids.length; x.error = ''; });
                } catch (e) {
                    updateSearch(s.id, x => { x.error = clip(e.message, 120) || 'Fehler'; });
                }
                await sleep(CONFIG.requestGapMs);
            }
        } finally {
            checking = false;
        }
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .kss-tab {
            position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 2147482400;
            writing-mode: vertical-rl; display: inline-flex; align-items: center; gap: 6px;
            padding: 12px 6px; border: 1px solid #d0d0cc; border-right: 0; border-radius: 10px 0 0 10px;
            background: #fff; color: #1e1e1e; font: inherit; font-size: 13px; font-weight: 600;
            box-shadow: -2px 4px 14px rgba(0,0,0,.15); cursor: pointer;
        }
        .kss-tab[hidden] { display: none; }
        .kss-tab:hover, .kss-tab:focus-visible { border-color: #1e1e1e; outline: none; }
        .kss-tab-count { writing-mode: horizontal-tb; padding: 0 6px; border-radius: 999px; background: #1e88e5; color: #fff; font-size: 11px; line-height: 18px; }

        .kss-panel {
            position: fixed; right: 12px; top: 72px; z-index: 2147482400; box-sizing: border-box;
            width: min(320px, calc(100vw - 24px)); max-height: calc(100vh - 150px); overflow: auto;
            background: #fff; color: #1e1e1e; border: 1px solid #d0d0cc; border-radius: 12px;
            box-shadow: 0 12px 32px rgba(0,0,0,.22); font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
        }
        .kss-panel *, .kss-panel *::before, .kss-panel *::after { box-sizing: border-box; }
        .kss-panel button, .kss-panel input { font: inherit; font-size: 14px; color: inherit; }
        .kss-head {
            position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
            padding: 8px 8px 8px 14px; background: #fff; border-bottom: 1px solid #eceae6;
        }
        .kss-title { flex: 1; min-width: 0; font-weight: 700; }
        .kss-body { padding: 10px 12px 12px; display: grid; gap: 10px; }
        .kss-icon-btn {
            flex: none; width: 28px; height: 28px; display: inline-grid; place-items: center;
            border: 0; border-radius: 8px; background: transparent; color: #555; cursor: pointer; font-size: 15px; line-height: 1;
        }
        .kss-icon-btn:hover:not(:disabled), .kss-icon-btn:focus-visible { background: #f2f1ee; color: #1e1e1e; outline: none; }
        .kss-icon-btn:disabled { opacity: .3; cursor: default; }
        .kss-head .kss-icon-btn { width: 32px; height: 32px; font-size: 18px; }
        .kss-save { display: grid; gap: 6px; padding: 10px; border: 1px dashed #c9c7c2; border-radius: 8px; background: #faf9f7; }
        .kss-row { display: flex; align-items: center; gap: 6px; }
        .kss-input { flex: 1; min-width: 0; width: 100%; padding: 6px 8px; border: 1px solid #c9c7c2; border-radius: 8px; background: #fff; }
        .kss-input:focus { outline: 2px solid #1e1e1e; outline-offset: -1px; }
        .kss-action {
            flex: none; padding: 6px 12px; border-radius: 999px; border: 1px solid #1e1e1e; background: #1e1e1e; color: #fff;
            font-weight: 600; cursor: pointer; white-space: nowrap;
        }
        .kss-action[data-plain] { background: #fff; color: #1e1e1e; border-color: #c9c7c2; }
        .kss-action:hover, .kss-action:focus-visible { outline: 2px solid #1e1e1e; outline-offset: 1px; }
        .kss-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
        .kss-item { display: flex; align-items: center; gap: 4px; padding: 6px 4px 6px 10px; border: 1px solid #e3e1dc; border-radius: 8px; }
        .kss-item[data-current] { border-color: #1e1e1e; background: #f7f6f3; }
        .kss-item-main { flex: 1; min-width: 0; display: grid; gap: 1px; }
        .kss-item-main a { color: #1e1e1e; font-weight: 600; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .kss-item-main a:hover { text-decoration: underline; }
        .kss-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 12px; color: #6b6b6b; }
        .kss-new { padding: 0 7px; border-radius: 999px; background: #1e88e5; color: #fff; font-weight: 600; line-height: 17px; }
        .kss-key { font-size: 11px; padding: 0 4px; border: 1px solid #d0d0cc; border-radius: 4px; color: #6b6b6b; }
        .kss-tools { display: flex; flex: none; }
        .kss-hint { margin: 0; font-size: 12px; color: #6b6b6b; }
        .kss-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
        .kss-check input { margin: 2px 0 0; accent-color: #1e1e1e; flex: none; }
        .kss-link { padding: 0; border: 0; background: none; color: #555; text-decoration: underline; font-size: 12px; cursor: pointer; }
        .kss-link:hover { color: #1e1e1e; }
    `;
    const ensureStyles = () => { if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl); };

    // ------------------------------------------------------------------
    // Sidebar
    // ------------------------------------------------------------------

    const tab = el('button', { type: 'button', className: 'kss-ui kss-tab', title: 'Gespeicherte Suchen',
        onclick: () => setSetting('open', !settings.open) });
    const panel = el('aside', { className: 'kss-ui kss-panel', 'aria-label': 'Gespeicherte Suchen' });
    let editingId = null;
    let draftName = null; // Name im Speichern-Feld, bleibt beim Neuzeichnen erhalten

    function newText(s) {
        if (!s.count) return '';
        return `${s.count}${s.total && s.count >= s.total ? '+' : ''} neu`;
    }

    function renderTab() {
        const total = searches.reduce((n, s) => n + (s.url === currentKey ? 0 : s.count), 0);
        // Ohne neue Anzeigen keine Zahl (replaceChildren würde null als Text "null" einsetzen)
        tab.replaceChildren(...[el('span', {}, '★ Suchen'), total ? el('span', { className: 'kss-tab-count' }, String(total)) : null].filter(Boolean));
        tab.setAttribute('aria-expanded', String(settings.open));
        tab.hidden = settings.open;
        if (!tab.isConnected) document.body.appendChild(tab);
    }

    function itemRow(s, i) {
        const isCurrent = s.url === currentKey;
        if (editingId === s.id) {
            const input = el('input', { className: 'kss-input', type: 'text', value: s.name, maxLength: CONFIG.nameMax, 'aria-label': 'Name der Suche' });
            const done = (keep) => {
                const name = clip(input.value, CONFIG.nameMax);
                editingId = null;
                if (keep && name) updateSearch(s.id, x => { x.name = name; }); else render();
            };
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') { e.stopPropagation(); done(false); }
            });
            setTimeout(() => { input.focus(); input.select(); }, 0);
            return el('li', { className: 'kss-item', dataset: isCurrent ? { current: '' } : null },
                el('div', { className: 'kss-row', style: 'flex:1' }, input,
                    el('button', { type: 'button', className: 'kss-action', onclick: () => done(true) }, 'OK')));
        }
        const meta = [
            i < 9 && settings.shortcuts ? el('span', { className: 'kss-key', title: `Tastenkürzel Alt+${i + 1}` }, `Alt+${i + 1}`) : null,
            el('span', {}, isCurrent ? 'gerade offen' : s.visited ? `besucht ${relTime(s.visited)}` : 'noch nicht besucht'),
            !isCurrent && settings.newCounts && s.count ? el('span', { className: 'kss-new', title: `Geprüft ${relTime(s.checked)}` }, newText(s)) : null,
            !isCurrent && settings.newCounts && s.error ? el('span', { title: s.error }, '⚠ nicht geprüft') : null,
        ];
        const move = (d) => mutate(list => {
            const from = list.findIndex(x => x.id === s.id);
            const to = from + d;
            if (from < 0 || to < 0 || to >= list.length) return;
            list.splice(to, 0, list.splice(from, 1)[0]);
        });
        return el('li', { className: 'kss-item', dataset: isCurrent ? { current: '' } : null },
            el('div', { className: 'kss-item-main' },
                el('a', { href: s.url, title: s.name, 'aria-current': isCurrent ? 'page' : null }, s.name),
                el('div', { className: 'kss-meta' }, meta)),
            el('div', { className: 'kss-tools' },
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Nach oben', 'aria-label': `${s.name} nach oben`, disabled: i === 0, onclick: () => move(-1) }, '↑'),
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Nach unten', 'aria-label': `${s.name} nach unten`, disabled: i === searches.length - 1, onclick: () => move(1) }, '↓'),
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Umbenennen', 'aria-label': `${s.name} umbenennen`, onclick: () => { editingId = s.id; render(); } }, '✎'),
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Löschen', 'aria-label': `${s.name} löschen`,
                    onclick: () => { if (window.confirm(`Gespeicherte Suche „${s.name}“ löschen?`)) mutate(list => { const at = list.findIndex(x => x.id === s.id); if (at >= 0) list.splice(at, 1); }); } }, '🗑')));
    }

    function saveBox() {
        if (!currentKey || !mainListAdIds(document).length) return null;
        const cur = currentSearch();
        if (cur) return null;
        if (searches.length >= CONFIG.max) return el('p', { className: 'kss-hint' }, `Höchstens ${CONFIG.max} gespeicherte Suchen.`);
        if (draftName == null) draftName = suggestName();
        const input = el('input', { className: 'kss-input', type: 'text', value: draftName, maxLength: CONFIG.nameMax,
            'aria-label': 'Name für diese Suche', oninput: (e) => { draftName = e.target.value; } });
        const doSave = () => {
            const name = clip(input.value, CONFIG.nameMax) || suggestName();
            draftName = null;
            mutate(list => {
                if (list.some(x => x.url === currentKey) || list.length >= CONFIG.max) return;
                list.push(cleanSearch({ id: newId(), name, url: currentKey, added: Date.now(), visited: Date.now(), known: mainListAdIds(document) }));
            });
        };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
        return el('div', { className: 'kss-save' },
            el('span', { className: 'kss-hint' }, 'Diese Suche speichern als:'),
            el('div', { className: 'kss-row' }, input, el('button', { type: 'button', className: 'kss-action', onclick: doSave }, 'Speichern')));
    }

    function render() {
        ensureStyles();
        renderTab();
        if (!settings.open) {
            panel.remove();
            return;
        }
        // Fokus im Panel merken (z. B. Häkchen), damit Tastaturnutzer nach dem Neuzeichnen nicht herausfallen
        const focused = panel.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null;
        const list = searches.length
            ? el('ol', { className: 'kss-list' }, searches.map(itemRow))
            : el('p', { className: 'kss-hint' }, 'Noch keine Suche gespeichert. Suche ganz normal und speichere sie hier mit einem Namen.');
        panel.replaceChildren(
            el('div', { className: 'kss-head' },
                el('span', { className: 'kss-title' }, 'Gespeicherte Suchen'),
                el('button', { type: 'button', className: 'kss-icon-btn', 'aria-label': 'Einklappen', title: 'Einklappen',
                    onclick: () => { setSetting('open', false); tab.focus(); } }, '×')),
            el('div', { className: 'kss-body' },
                saveBox(),
                list,
                el('label', { className: 'kss-check' },
                    el('input', { type: 'checkbox', checked: settings.newCounts, dataset: { focus: 'counts' },
                        onchange: (e) => { setSetting('newCounts', e.target.checked); if (e.target.checked) checkSearches(true); } }),
                    el('span', {}, 'Neue Anzeigen zählen (lädt die erste Ergebnisseite jeder Suche höchstens einmal pro Stunde im Hintergrund)')),
                settings.newCounts && searches.length ? el('div', { className: 'kss-row' },
                    el('button', { type: 'button', className: 'kss-link', onclick: () => checkSearches(true) }, checking ? 'Wird geprüft …' : 'Jetzt prüfen')) : null));
        if (!panel.isConnected) document.body.appendChild(panel);
        if (focused) {
            const again = panel.querySelector(`[data-focus="${focused}"]`);
            if (again) again.focus({ preventScroll: true });
        }
    }

    // ------------------------------------------------------------------
    // Tastenkürzel Alt+1 … Alt+9
    // ------------------------------------------------------------------

    document.addEventListener('keydown', (e) => {
        if (!settings.shortcuts || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const m = /^Digit([1-9])$/.exec(e.code);
        if (!m) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const s = searches[Number(m[1]) - 1];
        if (!s) return;
        e.preventDefault();
        window.location.href = s.url;
    }, true);

    // ------------------------------------------------------------------
    // Einstellungen (im Superscript-Dialog)
    // ------------------------------------------------------------------

    KS.addSettings('suchen', () => [
        el('h3', {}, 'Gespeicherte Suchen'),
        KS.checkbox('Neue Anzeigen zählen: lädt die erste Ergebnisseite jeder gespeicherten Suche im Hintergrund, '
            + `höchstens einmal pro Stunde und ${CONFIG.checksPerVisit} Suchen pro Seitenaufruf`, settings.newCounts, v => setSetting('newCounts', v)),
        KS.checkbox('Tastenkürzel Alt+1 … Alt+9 für die ersten neun Suchen', settings.shortcuts, v => setSetting('shortcuts', v)),
        el('p', { className: 'ks-hint' }, `${searches.length} gespeicherte Suche${searches.length === 1 ? '' : 'n'}. `
            + 'Gezählt wird nur auf der ersten Ergebnisseite; am genauesten mit der Sortierung „Neueste zuerst“. '
            + 'In Firefox unter Linux wechselt Alt+1 … Alt+9 sonst die Tabs.'),
    ]);

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    const reload = () => { searches = loadSearches(); settings = loadSettings(); render(); };
    KS.onRemoteChange(CONFIG.keys.searches, reload);
    KS.onRemoteChange(CONFIG.keys.settings, reload);
    // Zurück-Taste: Seite kommt aus dem Cache, ohne dass das Script neu startet
    window.addEventListener('pageshow', (e) => { if (e.persisted) { reload(); noteVisit(); } });

    render();
    noteVisit();

    // Die Seite baut Teile neu auf und lädt Ergebnisse nach: Sidebar und Besuch nachziehen
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            if (!tab.isConnected || !styleEl.isConnected || (settings.open && !panel.isConnected)) render();
            if (currentSearch()) noteVisit();
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => { if (document.visibilityState === 'visible') checkSearches(false); }, CONFIG.checkDelayMs);
})();
