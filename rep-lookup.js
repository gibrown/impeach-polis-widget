/* Rep Lookup Widget — impeachpolis.org
 * Loaded via <script src="...rep-lookup.js"> in a WP Custom HTML block.
 * Reads data-api-key from <div id="rep-lookup-widget">.
 */
(function () {
  'use strict';

  const REPS_JSON_URL = 'https://cdn.jsdelivr.net/gh/gibrown/impeach-polis-widget@trunk/reps.json';
  const GEOCODING_API_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';
  const ARCGIS_ORG = 'https://services3.arcgis.com/1V8429k2MaAcIZUa/arcgis/rest/services';
  const HOUSE_DISTRICTS_URL = `${ARCGIS_ORG}/House_Members_2021_Districts/FeatureServer/0/query`;
  const SENATE_DISTRICTS_URL = `${ARCGIS_ORG}/Senate_Members_2021_Districts/FeatureServer/0/query`;

  // ── Pure utilities ──────────────────────────────────────────────────────────

  function normalizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  }

  function stanceSortOrder(stance) {
    return { supportive: 0, maybe: 1, contacted: 2, unknown: 3, opposed: 4 }[stance] ?? 3;
  }

  /**
   * Find a legislator in repsData by normalized name, falling back to district number.
   * chamber: 'house' or 'senate'
   */
  function matchRepByNameOrDistrict(name, district, chamber, repsData) {
    const normalizedTarget = normalizeName(name);
    const byName = repsData.officials.find(
      o => o.chamber === chamber && normalizeName(o.name) === normalizedTarget
    );
    if (byName) return byName;
    const districtNum = parseInt(district);
    return repsData.officials.find(
      o => o.chamber === chamber && o.district === districtNum
    ) || null;
  }

  /**
   * Parse an ArcGIS FeatureServer point-query response into { name, district } or null.
   */
  function parseArcGISResponse(data) {
    const feature = (data.features || [])[0];
    if (!feature) return null;
    const { District, FIRST_NAME, LAST_NAME } = feature.attributes;
    return { name: `${FIRST_NAME} ${LAST_NAME}`, district: District };
  }

  // ── Retry helper ─────────────────────────────────────────────────────────────

  async function withRetry(fn, retries = 2) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (e.noRetry || i >= retries) break;
        await new Promise(r => setTimeout(r, 600 * (i + 1)));
      }
    }
    throw lastErr;
  }

  // ── Data loading ─────────────────────────────────────────────────────────────

  async function fetchRepsData() {
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const url = isDev ? '/reps.json' : REPS_JSON_URL;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load reps.json: ${resp.status}`);
    return resp.json();
  }

  // ── Google APIs ──────────────────────────────────────────────────────────────

  function loadGoogleMapsSDK(apiKey) {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps && window.google.maps.places) {
        resolve();
        return;
      }
      // Suppress Google's visual auth-failure overlay — widget functions without autocomplete.
      if (!window.gm_authFailure) window.gm_authFailure = () => reject(new Error('Maps API key invalid'));
      const callbackName = '_rlGoogleMapsReady';
      window[callbackName] = resolve;
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=${callbackName}`;
      script.onerror = () => reject(new Error('Failed to load Google Maps SDK'));
      document.head.appendChild(script);
    });
  }

  async function geocodeAddress(address, apiKey) {
    const url = `${GEOCODING_API_BASE}?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Geocoding error ${resp.status}`);
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results.length) {
      const err = new Error('Address not found. Please enter a Colorado street address.');
      err.noRetry = true;
      throw err;
    }
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  }

  async function callArcGISDistrict(lat, lng, serviceUrl) {
    const params = new URLSearchParams({
      f: 'json',
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
      outFields: 'District,FIRST_NAME,LAST_NAME',
      returnGeometry: 'false',
    });
    const resp = await fetch(`${serviceUrl}?${params}`);
    if (!resp.ok) throw new Error(`District lookup error ${resp.status}`);
    return resp.json();
  }

  async function lookupCongressionalDistrict(lat, lng) {
    const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${lng}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Census geocoder error ${resp.status}`);
    const data = await resp.json();
    const geos = data.result?.geographies || {};
    // Layer name varies by vintage — find whichever Congressional Districts key is present
    const cdKey = Object.keys(geos).find(k => k.includes('Congressional Districts'));
    const districts = cdKey ? geos[cdKey] : [];
    if (!districts.length) return null;
    return parseInt(districts[0].BASENAME, 10);
  }

  /**
   * Pick one random card from US senators + statewide officials.
   * Synchronous — no network call needed.
   */
  function pickRandomFederalOrStatewide(officials) {
    const pool = officials.filter(
      o => o.chamber === 'federal_senate' || o.chamber === 'statewide'
    );
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Look up the user's US House rep by congressional district.
   * Returns the rep object, or null if the lookup fails.
   */
  async function lookupHouseRep(lat, lng, officials) {
    const houseReps = officials.filter(o => o.chamber === 'federal_house');
    try {
      const district = await lookupCongressionalDistrict(lat, lng);
      if (district !== null) {
        return houseReps.find(r => r.district === district) || null;
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  // ── Rendering helpers ─────────────────────────────────────────────────────────

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderStanceBadge(stance, secondary) {
    const cls = `rl-badge s-${stance}${secondary ? ' secondary' : ''}`;
    const labels = {
      supportive: `✔ Supports Special Session`,
      maybe: `Possibly Supports Special Session`,
      opposed: `✘ Opposes Special Session`,
      unknown: `Position Unknown on Special Session`,
      contacted: `Position Unknown on Special Session`,
    };
    const b = el('span', cls);
    b.textContent = labels[stance] || stance;
    return b;
  }

  function renderQuote(rep) {
    if (!rep.quote) return null;
    const div = el('div', `rl-quote q-${rep.special_session_stance}`);
    div.innerHTML = `"${escHtml(rep.quote)}"`;
    if (rep.quote_url) {
      const a = el('a');
      a.href = rep.quote_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '→ Source';
      div.appendChild(a);
    }
    return div;
  }

  function renderContactLinks(rep) {
    const div = el('div', 'rl-contact');
    if (rep.phone) {
      const a = el('a', 'phone');
      a.href = `tel:${rep.phone.replace(/\D/g, '')}`;
      a.textContent = `📞 ${rep.phone}`;
      div.appendChild(a);
    }
    if (rep.email) {
      const isUrl = rep.email.startsWith('http');
      const a = el('a', 'email');
      a.href = isUrl ? rep.email : `mailto:${rep.email}`;
      if (isUrl) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.textContent = `✉ ${isUrl ? 'Contact Form' : rep.email}`;
      div.appendChild(a);
    }
    if (rep.website && !rep.email) {
      const a = el('a', 'web');
      a.href = rep.website;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '🌐 Website';
      div.appendChild(a);
    }
    return div.children.length ? div : null;
  }

  function renderRaces(rep) {
    const races = (rep.races || []).filter(r => (r.competitors || []).length);
    if (!races.length) return null;

    const wrapper = el('div', 'rl-races');

    for (const race of races) {
      const section = el('div', 'rl-challengers');

      const labelText = race.race_type === 'reelection'
        ? 'Primary Challengers'
        : `Also Running for ${race.race_title}`;
      section.appendChild(el('div', 'rl-challengers-label', escHtml(labelText)));

      for (const ch of race.competitors) {
        const isSupporting = ch.special_session_stance === 'supportive';
        const isMaybe = ch.special_session_stance === 'maybe';
        const card = el('div', `rl-challenger${isSupporting ? ' supporting' : isMaybe ? ' maybe-supporting' : ''}`);

        if (isSupporting) {
          card.appendChild(el('div', 'rl-challenger-banner banner-supportive', '⭐ Supports Special Session'));
        } else if (isMaybe) {
          card.appendChild(el('div', 'rl-challenger-banner banner-maybe', '~ Possibly Supportive of Special Session'));
        }

        card.appendChild(el('div', 'rl-challenger-name', escHtml(ch.name)));
        if (ch.current_office) {
          card.appendChild(el('div', 'rl-challenger-office', escHtml(ch.current_office)));
        }

        const stancesDiv = el('div', 'rl-stances');
        stancesDiv.appendChild(renderStanceBadge(ch.special_session_stance, true));
        card.appendChild(stancesDiv);

        if (ch.quote) card.appendChild(renderQuote(ch));

        const contactDiv = el('div', 'rl-contact');
        if (ch.email) {
          const a = el('a', 'email'); a.href = `mailto:${ch.email}`; a.textContent = `✉ ${ch.email}`; contactDiv.appendChild(a);
        }
        if (ch.campaign_website) {
          const a = el('a', 'web'); a.href = ch.campaign_website; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '🌐 Website'; contactDiv.appendChild(a);
        }
        if (contactDiv.children.length) card.appendChild(contactDiv);

        section.appendChild(card);
      }
      wrapper.appendChild(section);
    }
    return wrapper.children.length ? wrapper : null;
  }

  function chamberLabel(rep) {
    const party = (rep.party || '').charAt(0).toUpperCase() + (rep.party || '').slice(1);
    let label;
    switch (rep.chamber) {
      case 'house':          label = `HD-${String(rep.district).padStart(2, '0')}`; break;
      case 'senate':         label = `SD-${String(rep.district).padStart(2, '0')}`; break;
      case 'federal_house':  label = rep.district ? `CD-${rep.district}` : (rep.title || 'US Rep'); break;
      case 'federal_senate': label = rep.title || 'US Senator'; break;
      case 'statewide':      label = rep.title || 'Statewide'; break;
      default:               label = rep.title || '';
    }
    return `${label} · ${party}`;
  }

  function renderCard(roleLabel, rep) {
    const stance = rep.special_session_stance || 'unknown';
    const card = el('div', `rl-card stance-${stance}`);

    card.appendChild(el('div', 'rl-card-role', escHtml(roleLabel)));
    card.appendChild(el('div', 'rl-card-name', escHtml(rep.name)));
    card.appendChild(el('div', 'rl-card-district', chamberLabel(rep)));

    const stancesDiv = el('div', 'rl-stances');
    for (const race of (rep.races || [])) {
      const badge = el('span', 'rl-badge s-election');
      if (race.race_type === 'running_for_other') {
        badge.textContent = `Running for ${race.race_title} — Primary June 30`;
      } else if (race.race_type === 'reelection') {
        badge.textContent = `Running for Re-election — Primary June 30`;
      } else {
        continue;
      }
      stancesDiv.appendChild(badge);
    }
    stancesDiv.appendChild(renderStanceBadge(stance, false));
    card.appendChild(stancesDiv);

    if (stance === 'maybe') {
      card.appendChild(el('div', 'rl-maybe-note', '⚠ Encouraging statement — not yet confirmed. Call and ask directly.'));
    }
    if ((stance === 'unknown' || stance === 'contacted') && rep.outreach_count > 0) {
      card.appendChild(el('div', 'rl-outreach-note', `⚠ ${rep.outreach_count} constituent${rep.outreach_count !== 1 ? 's' : ''} have contacted ${escHtml(rep.name.split(' ')[0])} — no response yet`));
    }

    const contact = renderContactLinks(rep);
    if (contact) card.appendChild(contact);

    const quote = renderQuote(rep);
    if (quote) card.appendChild(quote);

    if (stance !== 'supportive') {
      const races = renderRaces(rep);
      if (races) card.appendChild(races);
    }

    return card;
  }

  // ── Table rendering ──────────────────────────────────────────────────────────

  function renderTable(repsData) {
    const section = el('div', 'rl-table-section');

    // Toggle button — always visible, collapses/expands the body below
    const toggleBtn = el('button', 'rl-table-toggle');
    section.appendChild(toggleBtn);

    // Drawer body — hidden when section has 'collapsed' class
    const body = el('div', 'rl-drawer-body');
    body.appendChild(el('div', 'rl-table-subtitle', 'Every Colorado elected official (except Polis). Call or email yours.'));
    section.appendChild(body);

    function updateToggle() {
      const isCollapsed = section.classList.contains('collapsed');
      toggleBtn.innerHTML = `All Elected Officials <span class="rl-sort-arrow">${isCollapsed ? '▼' : '▲'}</span>`;
    }

    toggleBtn.addEventListener('click', () => {
      section.classList.toggle('collapsed');
      updateToggle();
    });

    updateToggle();

    const allReps = [
      ...repsData.officials.filter(o => o.chamber === 'house').sort((a, b) => a.district - b.district),
      ...repsData.officials.filter(o => o.chamber === 'senate').sort((a, b) => a.district - b.district),
      ...repsData.officials.filter(o => o.chamber !== 'house' && o.chamber !== 'senate'),
    ];

    let sortCol = 'stance';
    let sortDir = 'asc';

    function officeLabel(rep) {
      switch (rep.chamber) {
        case 'house':          return `State House HD-${String(rep.district).padStart(2, '0')}`;
        case 'senate':         return `State Senate SD-${String(rep.district).padStart(2, '0')}`;
        case 'federal_house':  return `US House CD-${rep.district || ''}`;
        case 'federal_senate': return 'US Senator';
        case 'statewide':      return rep.title || 'Statewide';
        default:               return rep.title || '';
      }
    }

    function tableSupportBadge(stance) {
      const map = {
        supportive: { text: 'Yes',     cls: 's-supportive' },
        maybe:      { text: 'Maybe',   cls: 's-maybe' },
        opposed:    { text: 'No',      cls: 's-opposed' },
      };
      const { text, cls } = map[stance] || { text: 'Unknown', cls: 's-unknown' };
      const b = el('span', `rl-badge secondary ${cls}`);
      b.textContent = text;
      return b;
    }

    function officeOrder(rep) {
      const order = { house: 0, senate: 1, federal_senate: 2, federal_house: 3, statewide: 4 };
      return (order[rep.chamber] ?? 5) * 1000 + (rep.district || 0);
    }

    function getSortedReps() {
      const rows = [...allReps];
      const dir = sortDir === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        if (sortCol === 'stance') {
          const d = stanceSortOrder(a.special_session_stance) - stanceSortOrder(b.special_session_stance);
          return d !== 0 ? d * dir : a.name.localeCompare(b.name);
        }
        if (sortCol === 'name') return a.name.localeCompare(b.name) * dir;
        if (sortCol === 'office') {
          const d = officeOrder(a) - officeOrder(b);
          return d !== 0 ? d * dir : a.name.localeCompare(b.name);
        }
        return 0;
      });
      return rows;
    }

    const table = el('table', 'rl-table');
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th class="rl-th-sort" data-col="stance">Supports Special Session</th>
      <th class="rl-th-sort" data-col="name">Name</th>
      <th class="rl-th-sort hide-mobile" data-col="office">Elected Office</th>
      <th>Phone</th>
      <th class="hide-mobile">Email</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    function renderRows() {
      tbody.innerHTML = '';
      for (const rep of getSortedReps()) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="stance-cell"></td>
          <td>${escHtml(rep.name)}</td>
          <td class="hide-mobile">${escHtml(officeLabel(rep))}</td>
          <td class="phone-cell">${rep.phone ? `<a href="tel:${rep.phone.replace(/\D/g,'')}">${escHtml(rep.phone)}</a>` : '—'}</td>
          <td class="email-cell hide-mobile">${rep.email ? `<a href="mailto:${rep.email}">${escHtml(rep.email)}</a>` : '—'}</td>
        `;
        tr.querySelector('.stance-cell').appendChild(tableSupportBadge(rep.special_session_stance));
        tbody.appendChild(tr);
      }

      // Update sort arrows on header cells
      thead.querySelectorAll('.rl-th-sort').forEach(th => {
        th.querySelector('.rl-sort-arrow')?.remove();
        if (th.dataset.col === sortCol) {
          const arrow = el('span', 'rl-sort-arrow');
          arrow.textContent = sortDir === 'asc' ? ' ↑' : ' ↓';
          th.appendChild(arrow);
        }
      });
    }

    thead.querySelectorAll('.rl-th-sort').forEach(th => {
      th.addEventListener('click', () => {
        if (sortCol === th.dataset.col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = th.dataset.col;
          sortDir = 'asc';
        }
        renderRows();
      });
    });

    renderRows();

    const wrapper = el('div', 'rl-table-wrapper');
    wrapper.appendChild(table);
    body.appendChild(wrapper);

    function collapse() {
      section.classList.add('collapsed');
      updateToggle();
    }

    return { section, collapse };
  }

  // ── Main widget init ──────────────────────────────────────────────────────────

  async function buildWidget(container, googleApiKey) {
    let repsData;

    try {
      repsData = await fetchRepsData();
    } catch (e) {
      container.appendChild(el('div', 'rl-error', `Could not load representative data: ${escHtml(e.message)}`));
      return;
    }

    // ── Search UI ──
    const searchSection = el('div', 'rl-search');

    const addressRow = el('div', 'rl-address-row');
    const addressInput = el('input', 'rl-address-input');
    addressInput.type = 'text';
    addressInput.placeholder = 'Enter your Colorado address…';
    addressInput.autocomplete = 'street-address';
    addressInput.setAttribute('data-1p-ignore', '');   // 1Password
    addressInput.setAttribute('data-lpignore', 'true'); // LastPass
    addressInput.setAttribute('data-bwignore', 'true'); // Bitwarden

    const searchBtn = el('button', 'rl-btn rl-btn-search');
    searchBtn.textContent = 'Find My Reps';
    addressRow.appendChild(addressInput);
    addressRow.appendChild(searchBtn);

    const divider = el('div', 'rl-divider', '— or —');

    const locationBtn = el('button', 'rl-btn rl-btn-location');
    locationBtn.textContent = '📍 Use My Location';

    const errorDiv = el('div', 'rl-error');
    errorDiv.style.display = 'none';

    searchSection.appendChild(addressRow);
    searchSection.appendChild(divider);
    searchSection.appendChild(locationBtn);
    searchSection.appendChild(errorDiv);
    container.appendChild(searchSection);

    // ── Results container ──
    const resultsDiv = el('div', 'rl-results');
    container.appendChild(resultsDiv);

    // ── Table (always shown; collapses after a lookup) ──
    const { section: tableSection, collapse: collapseTable } = renderTable(repsData);
    container.appendChild(tableSection);

    // Load Maps SDK in background for Places Autocomplete — non-blocking.
    // Address search + geolocation work fine without it.
    // Canonical Google Places Autocomplete integration:
    // place_changed fires on click-selection or Enter-on-highlighted-item (NOT on arrow navigation).
    // When autocomplete is loaded it owns all selection events; keydown only fires for the fallback.
    let autocompleteLoaded = false;
    // Cache coords from autocomplete so button click doesn't need to re-geocode.
    let cachedCoords = null;
    let cachedAddr = null;
    addressInput.addEventListener('input', () => { cachedCoords = null; cachedAddr = null; });

    loadGoogleMapsSDK(googleApiKey).then(() => {
      try {
        // Restrict suggestions to Colorado
        const coBounds = new window.google.maps.LatLngBounds(
          { lat: 36.99, lng: -109.06 },
          { lat: 41.00, lng: -102.04 }
        );
        const autocomplete = new window.google.maps.places.Autocomplete(addressInput, {
          types: ['address'],
          componentRestrictions: { country: 'us' },
          bounds: coBounds,
          strictBounds: true,
          fields: ['formatted_address', 'geometry'],
        });
        autocompleteLoaded = true;
        autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace();
          if (place && place.geometry && place.geometry.location) {
            cachedCoords = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() };
            cachedAddr = addressInput.value.trim();
            doLookup(cachedCoords.lat, cachedCoords.lng);
          } else {
            // Enter pressed without selecting a suggestion — geocode the typed text.
            const addr = addressInput.value.trim();
            if (addr) {
              clearError();
              withRetry(() => geocodeAddress(addr, googleApiKey))
                .then(coords => doLookup(coords.lat, coords.lng))
                .catch(e => showError(e.message));
            }
          }
        });
      } catch (_) { /* autocomplete unavailable, typed address + geocoding still works */ }
    }).catch(() => { /* Maps SDK failed, address input still works via Geocoding REST API */ });

    // ── Lookup handler ──
    function showError(msg) {
      errorDiv.textContent = msg;
      errorDiv.style.display = '';
    }
    function clearError() { errorDiv.style.display = 'none'; }

    async function doLookup(lat, lng) {
      // Colorado bounding box check
      if (lat < 36.99 || lat > 41.00 || lng < -109.06 || lng > -102.04) {
        showError('That address is outside Colorado. Please enter a Colorado address.');
        searchBtn.disabled = false;
        locationBtn.disabled = false;
        locationBtn.textContent = '📍 Use My Location';
        return;
      }
      clearError();
      resultsDiv.innerHTML = '<div class="rl-spinner">Looking up your representatives…</div>';
      searchBtn.disabled = true;
      locationBtn.disabled = true;

      let houseData, senateData;
      try {
        [houseData, senateData] = await Promise.all([
          withRetry(() => callArcGISDistrict(lat, lng, HOUSE_DISTRICTS_URL)),
          withRetry(() => callArcGISDistrict(lat, lng, SENATE_DISTRICTS_URL)),
        ]);
      } catch (e) {
        resultsDiv.innerHTML = '';
        showError(`Could not look up representatives: ${e.message}`);
        searchBtn.disabled = false;
        locationBtn.disabled = false;
        return;
      }

      const houseRep = parseArcGISResponse(houseData);
      const senateRep = parseArcGISResponse(senateData);

      resultsDiv.innerHTML = '';
      collapseTable();

      function renderLookupCard(roleLabel, openStatesRep, chamber) {
        if (!openStatesRep) return;
        const rep = matchRepByNameOrDistrict(openStatesRep.name, openStatesRep.district, chamber, repsData);
        if (rep) {
          resultsDiv.appendChild(renderCard(roleLabel, rep));
        } else {
          const card = el('div', 'rl-card');
          card.appendChild(el('div', 'rl-card-role', escHtml(roleLabel)));
          card.appendChild(el('div', 'rl-card-name', escHtml(openStatesRep.name)));
          card.appendChild(el('div', 'rl-card-district', `District ${escHtml(String(openStatesRep.district))}`));
          resultsDiv.appendChild(card);
        }
      }

      renderLookupCard('Your State House Rep', houseRep, 'house');
      renderLookupCard('Your State Senator', senateRep, 'senate');

      // Random federal/statewide card — synchronous, no network call
      const alsoRep = pickRandomFederalOrStatewide(repsData.officials);
      if (alsoRep) resultsDiv.appendChild(renderCard('Also Representing You', alsoRep));

      // Re-enable buttons immediately — don't wait for congressional lookup
      searchBtn.disabled = false;
      locationBtn.disabled = false;

      // US House rep — async Census lookup, appended when ready
      const houseRepCard = el('div', 'rl-card rl-card-loading');
      houseRepCard.appendChild(el('div', 'rl-card-role', 'Your US House Rep'));
      houseRepCard.appendChild(el('div', 'rl-spinner', 'Looking up your congressional district…'));
      resultsDiv.appendChild(houseRepCard);
      lookupHouseRep(lat, lng, repsData.officials).then(usRep => {
        if (usRep) {
          houseRepCard.replaceWith(renderCard('Your US House Rep', usRep));
        } else {
          houseRepCard.remove();
        }
      });
    }

    // Address form submit — use cached autocomplete coords if available, else geocode.
    searchBtn.addEventListener('click', async () => {
      const addr = addressInput.value.trim();
      if (!addr) { showError('Please enter an address.'); return; }
      clearError();
      if (cachedCoords && cachedAddr === addr) {
        doLookup(cachedCoords.lat, cachedCoords.lng);
        return;
      }
      let coords;
      try {
        coords = await withRetry(() => geocodeAddress(addr, googleApiKey));
      } catch (e) {
        showError(e.message);
        return;
      }
      doLookup(coords.lat, coords.lng);
    });
    // When autocomplete is loaded, place_changed handles Enter (fires even without a selection).
    // This fallback covers: autocomplete not loaded, or SDK failed.
    addressInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !autocompleteLoaded) searchBtn.click();
    });

    // Geolocation button — pass coordinates directly to district lookup
    locationBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        showError('Geolocation is not supported by your browser.');
        return;
      }
      locationBtn.disabled = true;
      locationBtn.textContent = '📍 Getting location…';
      navigator.geolocation.getCurrentPosition(
        pos => {
          locationBtn.textContent = '📍 Use My Location';
          doLookup(pos.coords.latitude, pos.coords.longitude);
        },
        () => {
          locationBtn.disabled = false;
          locationBtn.textContent = '📍 Use My Location';
          showError('Could not get your location. Please enter your address instead.');
        }
      );
    });
  }

  // ── Entry point ───────────────────────────────────────────────────────────────

  function init() {
    const container = document.getElementById('rep-lookup-widget');
    if (!container) return;
    const googleApiKey = container.dataset.apiKey;
    if (!googleApiKey) {
      container.textContent = 'Widget error: missing data-api-key attribute.';
      return;
    }
    buildWidget(container, googleApiKey);
  }

  // Export pure functions for Node.js testing (must come before DOM access)
  if (typeof module !== 'undefined') {
    module.exports = { normalizeName, matchRepByNameOrDistrict, stanceSortOrder, parseArcGISResponse, chamberLabel };
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
